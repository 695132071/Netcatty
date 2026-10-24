import test from "node:test";
import assert from "node:assert/strict";

import type { ConnectionLog } from "./models.ts";
import { selectConnectionLogForTerminalDataCapture } from "./connectionLog.ts";
import {
  MAX_PERSISTED_UNSAVED_TERMINAL_DATA_ENTRIES,
  acknowledgePendingConnectionLogWrites,
  diffTerminalDataMaps,
  mergeConnectionLogsFromStorage,
  mergeConnectionLogsWithPendingMutations,
  mergeTerminalDataIntoLogs,
  mergeTerminalDataMapsForStorage,
  pruneInMemoryUnsavedTerminalData,
  pruneTerminalDataMapForStorage,
  rebaseQueuedConnectionLogs,
  retainNewestUnsavedReplays,
  type PendingConnectionLogWrite,
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

test("pending capture survives a peer snapshot and queued persistence rebase", () => {
  const local = { ...baseLog, id: "local", startTime: 3000, terminalData: "capture" };
  const peer = { ...baseLog, id: "peer", startTime: 2000 };
  const memory = mergeConnectionLogsWithPendingMutations(
    [local, baseLog], [peer, baseLog], {}, new Map([[local.id, { log: local, changes: local, added: true }]]),
  );
  const persisted = rebaseQueuedConnectionLogs(
    [local, baseLog], new Set(), new Set([local.id]), memory, [peer, baseLog],
  );
  assert.deepEqual(persisted.map((log) => log.id), ["local", "peer", "log-base"]);
  assert.equal(persisted[0].terminalData, "capture");
});

test("pending tombstone wins over a stale peer snapshot without deleting peer-only logs", () => {
  const peer = { ...baseLog, id: "peer" };
  const merged = mergeConnectionLogsWithPendingMutations(
    [], [baseLog, peer], {}, new Map([[baseLog.id, { log: null }]]),
  );
  assert.deepEqual(merged, [peer]);
});

test("unrelated pending mutation never resurrects a remotely deleted memory row", () => {
  const local = { ...baseLog, id: "local", terminalData: "capture" };
  const deleted = { ...baseLog, id: "remote-deleted", terminalData: "old" };
  const merged = mergeConnectionLogsWithPendingMutations(
    [local, deleted], [], {}, new Map([[local.id, { log: local, changes: local, added: true }]]),
  );
  assert.deepEqual(merged, [local]);
});

test("a pending final capture does not resurrect an existing log a peer deleted", () => {
  const captured = { ...baseLog, terminalData: "final capture" };
  const merged = mergeConnectionLogsWithPendingMutations(
    [captured], [], {},
    new Map([[baseLog.id, { log: captured, changes: { terminalData: "final capture" }, added: false }]]),
  );
  assert.deepEqual(merged, []);
});

test("pending capture preserves a peer bookmark and pending bookmark preserves a peer capture", () => {
  const captured = { ...baseLog, terminalData: "new capture", endTime: 2000 };
  const bookmarked = { ...baseLog, saved: true };
  const captureMerged = mergeConnectionLogsWithPendingMutations(
    [captured], [bookmarked], {},
    new Map([[baseLog.id, { log: captured, changes: { terminalData: "new capture", endTime: 2000 } }]]),
  );
  assert.equal(captureMerged[0].saved, true);
  assert.equal(captureMerged[0].terminalData, "new capture");
  const oldBookmark = { ...bookmarked, terminalData: "old capture" };
  const bookmarkMerged = mergeConnectionLogsWithPendingMutations(
    [oldBookmark], [captured], {}, new Map([[baseLog.id, { log: oldBookmark, changes: { saved: true } }]]),
  );
  assert.equal(bookmarkMerged[0].saved, true);
  assert.equal(bookmarkMerged[0].terminalData, "new capture");
  const sideStoreMerged = mergeConnectionLogsWithPendingMutations(
    [oldBookmark], [baseLog], { [baseLog.id]: "new capture" },
    new Map([[baseLog.id, { log: oldBookmark, changes: { saved: true } }]]),
  );
  assert.equal(sideStoreMerged[0].terminalData, "new capture");
});

test("pending replay overlay retains the newest 50 unsaved buffers and all saved buffers", () => {
  const logs = Array.from({ length: 65 }, (_, i) => ({
    ...baseLog, id: `log-${i}`, startTime: i, terminalData: `data-${i}`,
  }));
  const saved = { ...baseLog, id: "saved", startTime: -1, saved: true, terminalData: "saved data" };
  const merged = mergeConnectionLogsWithPendingMutations(
    [], [...logs, saved], {}, new Map(logs.map((log) => [log.id, { log, changes: log }])),
  );
  assert.equal(merged.length, 66);
  assert.equal(merged.filter((log) => !log.saved && log.terminalData).length, 50);
  assert.equal(merged.find((log) => log.id === "log-14")?.terminalData, undefined);
  assert.equal(merged.find((log) => log.id === "log-15")?.terminalData, "data-15");
  assert.equal(merged.find((log) => log.id === "saved")?.terminalData, "saved data");
});

test("older successful write retires inherited fields but keeps a later capture generation", () => {
  const first: PendingConnectionLogWrite = {
    generation: 1, added: true, log: baseLog,
    changes: { saved: false, terminalData: "first" }, fieldGenerations: { saved: 1, terminalData: 1 },
  };
  const later: PendingConnectionLogWrite = {
    generation: 2, added: true, log: { ...baseLog, terminalData: "final" },
    changes: { saved: false, terminalData: "final" }, fieldGenerations: { saved: 1, terminalData: 2 },
  };
  const pending = acknowledgePendingConnectionLogWrites(
    new Map([[baseLog.id, later]]), new Map([[baseLog.id, first]]),
  );
  assert.deepEqual(pending.get(baseLog.id)?.changes, { terminalData: "final" });
  assert.equal(pending.get(baseLog.id)?.added, false);
  const merged = mergeConnectionLogsWithPendingMutations(
    [later.log!], [{ ...baseLog, saved: true }], {}, pending,
  );
  assert.equal(merged[0].saved, true);
  assert.equal(merged[0].terminalData, "final");
});

test("older successful capture cannot acknowledge a newer pending deletion", () => {
  const first: PendingConnectionLogWrite = { generation: 1, log: baseLog };
  const deleted: PendingConnectionLogWrite = { generation: 2, log: null };
  const pending = acknowledgePendingConnectionLogWrites(
    new Map([[baseLog.id, deleted]]), new Map([[baseLog.id, first]]),
  );
  assert.equal(pending.get(baseLog.id), deleted);
  assert.equal(acknowledgePendingConnectionLogWrites(pending, pending).size, 0);
});

test("acknowledging one commit retains another failed or newer pending id for retry", () => {
  const first: PendingConnectionLogWrite = { generation: 1, log: baseLog };
  const retry: PendingConnectionLogWrite = { generation: 2, added: true, log: { ...baseLog, id: "retry" } };
  const pending = acknowledgePendingConnectionLogWrites(
    new Map([[baseLog.id, first], ["retry", retry]]), new Map([[baseLog.id, first]]),
  );
  assert.deepEqual([...pending.keys()], ["retry"]);
  assert.equal(mergeConnectionLogsWithPendingMutations([], [], {}, pending)[0].id, "retry");
});

test("metadata-only success retires add ownership without discarding failed replay", () => {
  const captured = { ...baseLog, terminalData: "failed replay" };
  const write: PendingConnectionLogWrite = {
    generation: 1, added: true, log: captured, changes: captured,
    fieldGenerations: Object.fromEntries(Object.keys(captured).map((field) => [field, 1])),
  };
  const pending = acknowledgePendingConnectionLogWrites(
    new Map([[baseLog.id, write]]), new Map([[baseLog.id, write]]),
    { metadataPersisted: true, replayPersisted: false },
  );
  assert.equal(pending.get(baseLog.id)?.added, false);
  assert.deepEqual(pending.get(baseLog.id)?.changes, { terminalData: "failed replay" });
  const bookmarked = mergeConnectionLogsWithPendingMutations(
    [captured], [{ ...baseLog, saved: true }], {}, pending,
  );
  assert.equal(bookmarked[0].saved, true);
  assert.equal(bookmarked[0].terminalData, "failed replay");
  assert.deepEqual(mergeConnectionLogsWithPendingMutations([captured], [], {}, pending), []);
});

test("partial acknowledgment preserves newer metadata and replay generations", () => {
  const first: PendingConnectionLogWrite = {
    generation: 1, added: true, log: baseLog, changes: { saved: false, terminalData: "first" },
    fieldGenerations: { saved: 1, terminalData: 1 },
  };
  const later: PendingConnectionLogWrite = {
    generation: 2, added: true, log: { ...baseLog, saved: true, terminalData: "later" },
    changes: { saved: true, terminalData: "later" }, fieldGenerations: { saved: 2, terminalData: 2 },
  };
  const pending = acknowledgePendingConnectionLogWrites(
    new Map([[baseLog.id, later]]), new Map([[baseLog.id, first]]),
    { metadataPersisted: true, replayPersisted: false },
  );
  assert.equal(pending.get(baseLog.id)?.added, false);
  assert.deepEqual(pending.get(baseLog.id)?.changes, later.changes);
});

test("failed metadata keeps add ownership even when the replay is durable", () => {
  const captured = { ...baseLog, terminalData: "durable replay" };
  const write: PendingConnectionLogWrite = {
    generation: 1, added: true, log: captured, changes: captured,
    fieldGenerations: Object.fromEntries(Object.keys(captured).map((field) => [field, 1])),
  };
  const pending = acknowledgePendingConnectionLogWrites(
    new Map([[baseLog.id, write]]), new Map([[baseLog.id, write]]),
    { metadataPersisted: false, replayPersisted: true },
  );
  assert.equal(pending.get(baseLog.id)?.added, true);
  assert.equal(pending.get(baseLog.id)?.changes?.saved, false);
  assert.equal(Object.hasOwn(pending.get(baseLog.id)?.changes ?? {}, "terminalData"), false);
});

test("durable saved replay and deletion retire ownership despite a failed side store", () => {
  const saved: PendingConnectionLogWrite = {
    generation: 1, added: true, log: { ...baseLog, saved: true, terminalData: "saved" },
    changes: { saved: true, terminalData: "saved" }, fieldGenerations: { saved: 1, terminalData: 1 },
  };
  const deleted: PendingConnectionLogWrite = { generation: 2, log: null };
  const writes = new Map([[baseLog.id, saved], ["deleted", deleted]]);
  assert.equal(acknowledgePendingConnectionLogWrites(writes, writes,
    { metadataPersisted: true, replayPersisted: false, mainReplay: { [baseLog.id]: "saved" } }).size, 0);
});

test("a stale saved flag cannot acknowledge replay omitted after a peer unbookmark", () => {
  const write: PendingConnectionLogWrite = {
    generation: 1, log: { ...baseLog, saved: true, terminalData: "failed final" },
    changes: { terminalData: "failed final" }, fieldGenerations: { terminalData: 1 },
  };
  for (const mainReplay of [{}, { [baseLog.id]: "older durable bytes" }]) {
    const pending = acknowledgePendingConnectionLogWrites(
      new Map([[baseLog.id, write]]), new Map([[baseLog.id, write]]),
      { metadataPersisted: true, replayPersisted: false, mainReplay },
    );
    assert.deepEqual(pending.get(baseLog.id)?.changes, { terminalData: "failed final" });
  }
});

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

test("rebaseQueuedConnectionLogs keeps logs another window wrote while this snapshot waited", () => {
  const queued = [{ ...baseLog, id: "local", startTime: 2000, terminalData: "local-replay" }];
  const memory = queued;
  const disk = [
    { ...baseLog, id: "remote", startTime: 3000 },
    { ...baseLog, id: "local", startTime: 2000 },
  ];

  const rebased = rebaseQueuedConnectionLogs(queued, new Set(), new Set(["local"]), memory, disk);

  assert.deepEqual(rebased.map((log) => log.id), ["remote", "local"]);
  assert.equal(rebased.find((log) => log.id === "local")?.terminalData, "local-replay");
});

test("rebaseQueuedConnectionLogs does not restore an id deleted from memory after it was queued", () => {
  const queued = [{ ...baseLog, id: "local", startTime: 2000, terminalData: "local-replay" }];
  const disk = [
    { ...baseLog, id: "remote", startTime: 3000 },
    { ...baseLog, id: "local", startTime: 2000, terminalData: "stale-intermediate" },
  ];

  const rebased = rebaseQueuedConnectionLogs(
    queued,
    new Set(),
    new Set(["local"]),
    [{ ...baseLog, id: "remote", startTime: 3000 }],
    disk,
  );

  assert.deepEqual(rebased.map((log) => log.id), ["remote"]);
  assert.equal(rebased.find((log) => log.id === "local"), undefined);

  const notYetOnDisk = rebaseQueuedConnectionLogs(
    queued,
    new Set(),
    new Set(["local"]),
    [{ ...baseLog, id: "remote", startTime: 3000 }],
    [{ ...baseLog, id: "remote", startTime: 3000 }],
  );
  assert.deepEqual(notYetOnDisk.map((log) => log.id), ["remote"]);
});

test("rebaseQueuedConnectionLogs does not restore an unchanged log another window deleted", () => {
  const unchanged = { ...baseLog, id: "unchanged", startTime: 1000, terminalData: "old" };
  const added = { ...baseLog, id: "local", startTime: 4000, terminalData: "local-replay" };
  const queued = [added, unchanged];
  const remote = [{ ...baseLog, id: "remote", startTime: 3000 }];

  const rebased = rebaseQueuedConnectionLogs(
    queued,
    new Set(),
    new Set(["local"]),
    [added, ...remote],
    remote,
  );

  assert.deepEqual(rebased.map((log) => log.id), ["local", "remote"]);
  assert.equal(rebased.find((log) => log.id === "unchanged"), undefined);
  assert.equal(rebased.find((log) => log.id === "local")?.terminalData, "local-replay");
});

test("rebaseQueuedConnectionLogs applies a local metadata edit onto the latest disk row", () => {
  const queued = [{ ...baseLog, id: "local", startTime: 2000, saved: true, terminalData: "replay" }];
  const disk = [
    { ...baseLog, id: "remote", startTime: 3000 },
    { ...baseLog, id: "local", startTime: 2000, saved: false },
  ];

  const rebased = rebaseQueuedConnectionLogs(
    queued,
    new Set(),
    new Set(["local"]),
    queued,
    disk,
  );

  assert.equal(rebased.find((log) => log.id === "local")?.saved, true);
  assert.equal(rebased.find((log) => log.id === "local")?.terminalData, "replay");
  assert.ok(rebased.some((log) => log.id === "remote"));
});

test("retainNewestUnsavedReplays drops older unsaved buffers and keeps the newest", () => {
  const logs: ConnectionLog[] = [
    { ...baseLog, id: "old", startTime: 1000, terminalData: "old" },
    { ...baseLog, id: "mid", startTime: 2000, terminalData: "mid" },
    { ...baseLog, id: "new", startTime: 3000, terminalData: "new" },
    { ...baseLog, id: "saved", startTime: 500, saved: true, terminalData: "saved" },
  ];

  const kept = retainNewestUnsavedReplays(logs, 1);

  assert.equal(kept.find((log) => log.id === "new")?.terminalData, "new");
  assert.equal(kept.find((log) => log.id === "saved")?.terminalData, "saved");
  assert.equal(kept.find((log) => log.id === "old")?.terminalData, undefined);
  assert.equal(kept.find((log) => log.id === "mid")?.terminalData, undefined);
});

test("rebaseQueuedConnectionLogs drops a queued delete and keeps a queued add still in memory", () => {
  const queued = [{ ...baseLog, id: "added", startTime: 4000, terminalData: "new" }];
  const memory = queued;
  const disk = [
    { ...baseLog, id: "deleted", startTime: 1000 },
    { ...baseLog, id: "kept", startTime: 2000 },
  ];

  const rebased = rebaseQueuedConnectionLogs(
    queued,
    new Set(["deleted"]),
    new Set(["added"]),
    memory,
    disk,
  );

  assert.deepEqual(rebased.map((log) => log.id), ["added", "kept"]);
  assert.equal(rebased.find((log) => log.id === "added")?.terminalData, "new");
});

test("diffTerminalDataMaps puts only changed ids and deletes removed ids", () => {
  const diff = diffTerminalDataMaps(
    { same: "keep", edited: "old", removed: "gone" },
    { same: "keep", edited: "new", added: "fresh" },
  );

  assert.deepEqual(diff.puts, { edited: "new", added: "fresh" });
  assert.deepEqual(diff.deleteIds, ["removed"]);
});

test("diffTerminalDataMaps treats key order as unchanged", () => {
  const diff = diffTerminalDataMaps(
    { b: "2", a: "1" },
    { a: "1", b: "2" },
  );

  assert.deepEqual(diff.puts, {});
  assert.deepEqual(diff.deleteIds, []);
});

test("prune cap diffs to deleting only replay buffers outside the newest 50", () => {
  const logs: ConnectionLog[] = Array.from({ length: 60 }, (_, index) => ({
    ...baseLog,
    id: `log-${index}`,
    startTime: index,
    saved: false,
  }));
  logs.push({
    ...baseLog,
    id: "saved-keep",
    startTime: 1,
    saved: true,
  });
  const map = Object.fromEntries(logs.map((log) => [log.id, `data-${log.id}`]));
  const pruned = pruneTerminalDataMapForStorage(logs, map);
  const diff = diffTerminalDataMaps(map, pruned);

  assert.equal(Object.keys(pruned).length, MAX_PERSISTED_UNSAVED_TERMINAL_DATA_ENTRIES + 1);
  assert.equal(Object.keys(diff.puts).length, 0);
  assert.equal(diff.deleteIds.length, 10);
  assert.equal(diff.deleteIds.includes("log-0"), true);
  assert.equal(diff.deleteIds.includes("log-9"), true);
  assert.equal(diff.deleteIds.includes("log-10"), false);
  assert.equal(diff.deleteIds.includes("log-59"), false);
  assert.equal(diff.deleteIds.includes("saved-keep"), false);
  assert.equal(pruned["saved-keep"], "data-saved-keep");
});
