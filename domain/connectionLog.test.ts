import test from "node:test";
import assert from "node:assert/strict";

import type { ConnectionLog } from "./models.ts";
import { selectConnectionLogForTerminalDataCapture } from "./connectionLog.ts";
import {
  MAX_PERSISTED_UNSAVED_TERMINAL_DATA_ENTRIES,
  mergeConnectionLogsFromStorage,
  mergeTerminalDataIntoLogs,
  mergeTerminalDataMapsForStorage,
  pruneInMemoryUnsavedTerminalData,
  pruneTerminalDataMapForStorage,
  writeTerminalDataMapWithQuotaRetry,
} from "./connectionLogTerminalData.ts";

const baseLog: ConnectionLog = {
  id: "log-base",
  sessionId: "session-1",
  hostId: "host-1",
  hostLabel: "Example",
  hostname: "example.com",
  username: "user",
  protocol: "ssh",
  startTime: 1000,
  localUsername: "local",
  localHostname: "machine",
  saved: false,
};

test("selectConnectionLogForTerminalDataCapture picks the active log for a normal session exit", () => {
  const matchingLog = { ...baseLog, id: "active", startTime: 2000 };
  const staleLog = {
    ...baseLog,
    id: "stale",
    sessionId: "session-2",
    startTime: 3000,
  };

  assert.equal(
    selectConnectionLogForTerminalDataCapture(
      [staleLog, matchingLog],
      { sessionId: "session-1", hostname: "example.com" },
    )?.id,
    "active",
  );
});

test("selectConnectionLogForTerminalDataCapture reuses the latest log for repeated captures after reconnect", () => {
  const firstCapture = {
    ...baseLog,
    id: "first-capture",
    startTime: 2000,
    endTime: 2500,
    terminalData: "first disconnect",
  };
  const olderSameSession = {
    ...baseLog,
    id: "older-same-session",
    startTime: 1500,
    endTime: 1800,
    terminalData: "older data",
  };
  const otherSession = {
    ...baseLog,
    id: "other-session",
    sessionId: "session-2",
    startTime: 3000,
  };

  assert.equal(
    selectConnectionLogForTerminalDataCapture(
      [otherSession, olderSameSession, firstCapture],
      { sessionId: "session-1", hostname: "example.com" },
    )?.id,
    "first-capture",
  );
});

test("selectConnectionLogForTerminalDataCapture does not cross-match localhost logs without sessionId", () => {
  const openLocalWithoutSession = {
    ...baseLog,
    id: "open-local",
    sessionId: undefined,
    hostname: "localhost",
    protocol: "local",
    startTime: 3000,
  };
  const targetLocal = {
    ...baseLog,
    id: "target-local",
    sessionId: "session-local-a",
    hostname: "localhost",
    protocol: "local",
    startTime: 2000,
  };

  assert.equal(
    selectConnectionLogForTerminalDataCapture(
      [openLocalWithoutSession, targetLocal],
      { sessionId: "session-local-b", hostname: "localhost" },
    ),
    undefined,
  );
});

test("mergeConnectionLogsFromStorage keeps in-memory terminal replay data", () => {
  const memoryLog = {
    ...baseLog,
    id: "memory",
    terminalData: "captured output",
  };
  const storedLog = {
    ...baseLog,
    id: "memory",
    endTime: 2000,
  };

  const merged = mergeConnectionLogsFromStorage(
    [memoryLog],
    [storedLog],
    {},
  );

  assert.equal(merged[0]?.terminalData, "captured output");
});

test("mergeTerminalDataIntoLogs hydrates unsaved logs from side storage", () => {
  const storedLog = { ...baseLog, id: "hydrate" };
  const hydrated = mergeTerminalDataIntoLogs([storedLog], {
    hydrate: "side-store output",
  });

  assert.equal(hydrated[0]?.terminalData, "side-store output");
});

test("pruneTerminalDataMapForStorage caps unsaved replay buffers", () => {
  const logs: ConnectionLog[] = Array.from({ length: 60 }, (_, index) => ({
    ...baseLog,
    id: `log-${index}`,
    startTime: index,
    saved: false,
  }));

  const map = Object.fromEntries(
    logs.map((log) => [log.id, `data-${log.id}`]),
  );

  const pruned = pruneTerminalDataMapForStorage(logs, map);
  assert.equal(Object.keys(pruned).length, MAX_PERSISTED_UNSAVED_TERMINAL_DATA_ENTRIES);
  assert.equal(pruned["log-59"], "data-log-59");
  assert.equal(pruned["log-0"], undefined);
});

test("pruneInMemoryUnsavedTerminalData drops oldest unsaved replay buffers beyond the persist cap", () => {
  const logs: ConnectionLog[] = Array.from({ length: 60 }, (_, index) => ({
    ...baseLog,
    id: `log-${index}`,
    startTime: index,
    saved: false,
    terminalData: `data-${index}`,
  }));
  // One bookmarked entry must keep its replay buffer even when unsaved count is high.
  logs.push({
    ...baseLog,
    id: "saved-keep",
    startTime: 0,
    saved: true,
    terminalData: "saved-data",
  });

  const pruned = pruneInMemoryUnsavedTerminalData(logs);
  const unsavedWithData = pruned.filter((log) => !log.saved && log.terminalData !== undefined);
  assert.equal(unsavedWithData.length, MAX_PERSISTED_UNSAVED_TERMINAL_DATA_ENTRIES);
  assert.equal(pruned.find((log) => log.id === "log-59")?.terminalData, "data-59");
  assert.equal(pruned.find((log) => log.id === "log-0")?.terminalData, undefined);
  assert.equal(pruned.find((log) => log.id === "log-0")?.id, "log-0"); // metadata kept
  assert.equal(pruned.find((log) => log.id === "saved-keep")?.terminalData, "saved-data");
  assert.equal(pruned.length, logs.length);
});

test("pruneInMemoryUnsavedTerminalData is a no-op at or under the cap", () => {
  const logs: ConnectionLog[] = Array.from({ length: 10 }, (_, index) => ({
    ...baseLog,
    id: `log-${index}`,
    startTime: index,
    terminalData: `data-${index}`,
  }));
  const pruned = pruneInMemoryUnsavedTerminalData(logs);
  assert.equal(pruned, logs);
});

test("mergeTerminalDataMapsForStorage keeps replay data from other windows", () => {
  const logs: ConnectionLog[] = [
    { ...baseLog, id: "local", startTime: 2000 },
    { ...baseLog, id: "remote", startTime: 1000 },
  ];

  const merged = mergeTerminalDataMapsForStorage(
    logs,
    { remote: "remote-window output", other: "other-window only" },
    [{ local: "local-window output" }],
    new Set(["local", "remote", "other"]),
  );

  assert.equal(merged.remote, "remote-window output");
  assert.equal(merged.local, "local-window output");
  assert.equal(merged.other, "other-window only");
});

test("mergeTerminalDataMapsForStorage prefers fresher local replay data for orphans", () => {
  const logs: ConnectionLog[] = [{ ...baseLog, id: "local", startTime: 2000 }];

  const merged = mergeTerminalDataMapsForStorage(
    logs,
    { other: "stale snapshot" },
    [{ other: "fresh local" }],
    new Set(["local", "other"]),
  );

  assert.equal(merged.other, "fresh local");
});

test("mergeTerminalDataMapsForStorage drops deleted log replay buffers", () => {
  const logs: ConnectionLog[] = [{ ...baseLog, id: "local", startTime: 2000 }];

  const merged = mergeTerminalDataMapsForStorage(
    logs,
    { local: "keep", deleted: "drop me" },
    [],
    new Set(["local"]),
  );

  assert.equal(merged.local, "keep");
  assert.equal(merged.deleted, undefined);
});

const quotaLogs = (count: number): ConnectionLog[] =>
  Array.from({ length: count }, (_, index) => ({
    ...baseLog,
    id: `log-${index}`,
    startTime: index,
    saved: false,
  }));

const quotaWriter = (limitChars: number) => {
  const calls: number[] = [];
  const write = (next: Record<string, string>) => {
    const size = Object.values(next).reduce((sum, value) => sum + value.length, 0);
    calls.push(Object.keys(next).length);
    return size <= limitChars;
  };
  return { calls, write };
};

test("writeTerminalDataMapWithQuotaRetry writes once when it fits", () => {
  const logs = quotaLogs(5);
  const map = Object.fromEntries(logs.map((log) => [log.id, "x".repeat(10)]));
  const { calls, write } = quotaWriter(1000);
  const result = writeTerminalDataMapWithQuotaRetry(logs, map, write, null);
  assert.equal(result.persisted, true);
  assert.equal(result.written, map);
  assert.deepEqual(calls, [5]);
});

test("writeTerminalDataMapWithQuotaRetry drops the oldest unsaved entries until it fits", () => {
  const logs = quotaLogs(50);
  // Newest first, matching pruneTerminalDataMapForStorage order.
  const map = Object.fromEntries(
    [...logs].reverse().map((log) => [log.id, "x".repeat(10)]),
  );
  const { calls, write } = quotaWriter(10 * 47);
  const result = writeTerminalDataMapWithQuotaRetry(logs, map, write, null);
  assert.equal(result.persisted, true);
  // 50 fails, drop 1 → 49 fails, drop 2 → 48 fails, drop 4 → 46 fits.
  assert.deepEqual(calls, [50, 49, 48, 46]);
  assert.equal(result.written["log-49"], map["log-49"]);
  assert.equal(result.written["log-4"], map["log-4"]);
  for (const id of ["log-0", "log-1", "log-2", "log-3"]) {
    assert.equal(result.written[id], undefined);
  }
  // Key order (newest first) is preserved.
  assert.deepEqual(Object.keys(result.written), Object.keys(map).filter((id) => id in result.written));
});

test("writeTerminalDataMapWithQuotaRetry never drops saved or unknown entries and stops after all unsaved are gone", () => {
  const logs: ConnectionLog[] = [
    ...quotaLogs(20),
    { ...baseLog, id: "saved", startTime: -1, saved: true },
  ];
  const map: Record<string, string> = Object.fromEntries(
    logs.map((log) => [log.id, "x".repeat(10)]),
  );
  map["other-window"] = "y".repeat(10);
  const { calls, write } = quotaWriter(5); // nothing fits
  const result = writeTerminalDataMapWithQuotaRetry(logs, map, write, null);
  assert.equal(result.persisted, false);
  assert.equal(result.written, map);
  // 22, then drop 1, 2, 4, 8, 16, then all 20 unsaved: bounded attempts.
  assert.deepEqual(calls, [22, 21, 20, 18, 14, 6, 2]);
  assert.ok(result.attempts <= 2 + Math.ceil(Math.log2(20)));
});

const newestFirstMap = (logs: ConnectionLog[], chars: number) =>
  Object.fromEntries([...logs].reverse().map((log) => [log.id, "x".repeat(chars)]));

test("writeTerminalDataMapWithQuotaRetry starts the next write from the newest set that last fit", () => {
  const logs = quotaLogs(50);
  const quota = quotaWriter(10 * 47);
  const first = writeTerminalDataMapWithQuotaRetry(logs, newestFirstMap(logs, 10), quota.write, null);
  // Next close: oldest drops out of the 50, a newer session arrives.
  const nextLogs = [...logs.slice(1), { ...baseLog, id: "log-50", startTime: 50 }];
  const second = quotaWriter(10 * 47);
  const result = writeTerminalDataMapWithQuotaRetry(
    nextLogs,
    newestFirstMap(nextLogs, 10),
    second.write,
    first.quotaFailedChars,
  );
  assert.equal(result.persisted, true);
  assert.deepEqual(second.calls, [47]);
  assert.equal(result.written["log-50"] !== undefined, true);
  assert.equal(result.written["log-3"], undefined);
});

test("writeTerminalDataMapWithQuotaRetry grows back when entries get smaller", () => {
  const logs = quotaLogs(50);
  const first = writeTerminalDataMapWithQuotaRetry(
    logs,
    newestFirstMap(logs, 10),
    quotaWriter(10 * 47).write,
    null,
  );
  const small = quotaWriter(10 * 47);
  const result = writeTerminalDataMapWithQuotaRetry(
    logs,
    newestFirstMap(logs, 5),
    small.write,
    first.quotaFailedChars,
  );
  assert.deepEqual(small.calls, [50]);
  assert.equal(Object.keys(result.written).length, 50);
});

test("writeTerminalDataMapWithQuotaRetry falls back to dropping when the hint is too optimistic", () => {
  const logs = quotaLogs(50);
  const first = writeTerminalDataMapWithQuotaRetry(
    logs,
    newestFirstMap(logs, 10),
    quotaWriter(10 * 47).write,
    null,
  );
  const tighter = quotaWriter(10 * 30); // quota shrank (other keys grew)
  const result = writeTerminalDataMapWithQuotaRetry(
    logs,
    newestFirstMap(logs, 10),
    tighter.write,
    first.quotaFailedChars,
  );
  assert.equal(result.persisted, true);
  assert.equal(tighter.calls[0], 47);
  assert.ok(Object.keys(result.written).length <= 30);
  assert.equal(result.written["log-49"] !== undefined, true);
  assert.ok(result.attempts <= 2 + Math.ceil(Math.log2(50)));
});
