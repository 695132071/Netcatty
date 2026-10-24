import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./useVaultState.ts", import.meta.url), "utf8");
const terminalLayerSource = readFileSync(
  new URL("../../components/TerminalLayer.tsx", import.meta.url),
  "utf8",
);

test("connection log replay blobs persist through IndexedDB instead of the legacy localStorage blob", () => {
  assert.match(source, /await migrateLegacyConnectionLogTerminalData\(/);
  assert.match(source, /await writeTerminalDataMapDiff\(/);
  assert.match(source, /STORAGE_KEY_CONNECTION_LOG_TERMINAL_DATA_REV/);
  assert.match(source, /syncConnectionLogTerminalData !== false|syncConnectionLogTerminalData\)/);
  assert.doesNotMatch(source, /writeTerminalDataMapWithQuotaRetry/);
  assert.doesNotMatch(
    source,
    /localStorageAdapter\.write\(\s*STORAGE_KEY_CONNECTION_LOG_TERMINAL_DATA\s*,/,
  );
});

test("close-path connection log updates await the indexedDB persist task", () => {
  assert.match(
    source,
    /const updateConnectionLog = useCallback\([\s\S]*?return commitConnectionLogs\(/,
  );
  assert.match(source, /rebaseQueuedConnectionLogs\(\s*memory,\s*removedIds,\s*changedIds,/);
  assert.match(
    source,
    /if \(!options\?\.pruneMainBlob\) \{[\s\S]*?rebaseQueuedConnectionLogs\(/,
  );
  assert.match(source, /retainNewestUnsavedReplays\(fallbackLogs, keep\)/);
  assert.match(source, /if \(!map\) return;/);
  assert.match(
    source,
    /if \(key === STORAGE_KEY_CONNECTION_LOGS\) \{\s*\/\/ This window already updated connectionLogsRef before setItem\.[\s\S]*?return;\s*\}/,
  );
  assert.match(
    terminalLayerSource,
    /const handleTerminalDataCapture = useCallback\(\(sessionId: string, data: string\) => \{\s*return onTerminalDataCapture\?\.\(sessionId, data\);/,
  );
});

test("boot re-reads connection logs after indexedDB load and falls back to the main blob", () => {
  const revAt = source.indexOf("let revSeen = readTerminalDataRev()");
  const bootAt = source.indexOf("const loaded = await migrateLegacyConnectionLogTerminalData");
  assert.notEqual(revAt, -1);
  assert.ok(revAt < bootAt);
  const bootSlice = source.slice(bootAt, bootAt + 2800);
  assert.match(bootSlice, /revNow !== revSeen[\s\S]*?await loadConnectionLogTerminalData\(\)/);
  assert.match(
    bootSlice,
    /localStorageAdapter\.read<ConnectionLog\[\]>\(\s*STORAGE_KEY_CONNECTION_LOGS,\s*\)[\s\S]*?pruneTerminalDataMapForStorage\(connectionLogsForBoot/,
  );
  assert.match(
    source,
    /!sidePersisted && unsavedTerminalDataPending && mainPersisted\) \{\s*\/\/[\s\S]*?localStorageAdapter\.read<ConnectionLog\[\]>\(\s*STORAGE_KEY_CONNECTION_LOGS\s*\)[\s\S]*?mergeTerminalDataIntoLogs\(freshLogs, buildTerminalDataMapFromLogs\(logs\)\)/,
  );
});
