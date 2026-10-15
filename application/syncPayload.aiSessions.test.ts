import test from 'node:test';
import assert from 'node:assert/strict';
import type { AISession } from '../infrastructure/ai/types';
import type { SyncPayload } from '../domain/sync';

const storage = new Map<string, string>();
const events = new EventTarget();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });
Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
const keys = await import('../infrastructure/config/storageKeys');
const snapshots = await import('./state/aiStateSnapshots');
const { getAISessionsSnapshot } = await import('./state/aiSessionsStore');
const {
  buildCloudSyncPayload, buildLocalVaultPayload, collectAiSessionsForSync,
  applySyncPayload, applyLocalVaultPayload, hasMeaningfulSyncData,
} = await import('./syncPayload');

const vault = { hosts: [], keys: [], identities: [], snippets: [], customGroups: [], knownHosts: [] };
const session = (): AISession => ({
  id: 'chat', title: 'Chat', agentId: 'catty', scope: { type: 'global' }, createdAt: 1, updatedAt: 2,
  messages: [{ id: 'message', role: 'user', content: 'Inspect', timestamp: 1, attachments: [{
    filename: 'terminal.log', mediaType: 'text/plain', terminalSelection: true,
    base64Data: 'cHJpdmF0ZQ==', previewText: 'private', filePath: '/private/device/file', lineCount: 1,
  }] }],
});
function save(sessions: AISession[], enabled = true) {
  snapshots.setLatestAISessionsSnapshot(sessions);
  storage.set(keys.STORAGE_KEY_AI_SESSIONS, JSON.stringify(sessions));
  storage.set(keys.STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS, JSON.stringify({ enabled }));
}
test.beforeEach(() => { storage.clear(); save([], false); });

test('actual manual upload and auto collector honor consent and explicit empty', async () => {
  save([session()], false);
  const options = { collectPluginSidecars: () => undefined };
  assert.equal((await buildCloudSyncPayload(vault, [], options)).aiSessions, undefined);
  assert.equal(collectAiSessionsForSync(), undefined);
  save([], true);
  assert.deepEqual((await buildCloudSyncPayload(vault, [], options)).aiSessions, []);
  assert.deepEqual(collectAiSessionsForSync(), []);
  save([session()], true);
  const cloud = await buildCloudSyncPayload(vault, [], options);
  assert.equal(cloud.aiSessions?.length, 1);
  assert.deepEqual(cloud.aiSessions, collectAiSessionsForSync());
  assert.equal(JSON.stringify(cloud).includes('cHJpdmF0ZQ=='), false);
  assert.equal(JSON.stringify(cloud).includes('/private/device/file'), false);
  assert.equal(JSON.stringify(cloud.aiSessions?.[0].messages[0].attachments).includes('private'), false);
});

test('local backup retains chat and attachment bytes with cloud consent off', async () => {
  const local = session();
  save([local], false);
  const backup = buildLocalVaultPayload(vault);
  assert.deepEqual(backup.aiSessions, [local]);
  assert.equal(hasMeaningfulSyncData({ ...vault, aiSessions: [local], syncedAt: 1 }), true);
  save([], false);
  await applyLocalVaultPayload(backup, { importVaultData: () => undefined }, {
    prepareConvergentRestore: async () => async () => {},
  });
  assert.equal(getAISessionsSnapshot().sessions[0].messages[0].attachments?.[0].base64Data, 'cHJpdmF0ZQ==');
});

test('download publishes immediately and keeps local attachment bytes on a newer message', async () => {
  save([session()]);
  const incoming = session();
  incoming.updatedAt = 3;
  incoming.messages[0].content = 'Updated';
  incoming.messages[0].attachments = [{ base64Data: '', mediaType: 'text/plain', filename: 'terminal.log', terminalSelection: true, contentUnavailable: true }];
  const payload: SyncPayload = { ...vault, aiSessions: [incoming], syncedAt: 2 };
  await applySyncPayload(payload, { importVaultData: () => undefined });
  const current = getAISessionsSnapshot().sessions[0];
  assert.equal(current.messages[0].content, 'Updated');
  assert.equal(current.messages[0].attachments?.[0].base64Data, 'cHJpdmF0ZQ==');
  assert.equal(snapshots.latestAISessionsSnapshot?.[0], current);
  assert.equal(JSON.parse(storage.get(keys.STORAGE_KEY_AI_SESSIONS)!)[0].messages[0].content, 'Updated');
});

test('restoring an old backup without chat leaves current chats alone', async () => {
  const local = session();
  save([local], false);
  await applyLocalVaultPayload({ ...vault, syncedAt: 1 }, { importVaultData: () => undefined }, {
    prepareConvergentRestore: async () => async () => {},
  });
  assert.deepEqual(snapshots.latestAISessionsSnapshot, [local]);
  assert.deepEqual(JSON.parse(storage.get(keys.STORAGE_KEY_AI_SESSIONS)!), [local]);
});

test('cloud restore never resumes a source device SDK thread, and preserves matching local threads', async () => {
  const local = { ...session(), externalSessionId: 'local-native-thread' };
  save([local]);
  const incoming = { ...session(), updatedAt: 3, externalSessionId: 'remote-native-thread' };
  const fresh = { ...incoming, id: 'new-chat' };
  await applySyncPayload({ ...vault, aiSessions: [incoming, fresh], syncedAt: 2 }, { importVaultData: () => undefined });
  const current = getAISessionsSnapshot().sessions;
  assert.equal(current.find((s) => s.id === 'chat')?.externalSessionId, 'local-native-thread');
  assert.equal(current.find((s) => s.id === 'new-chat')?.externalSessionId, undefined);
});

test('changed remote transcript resets the local native SDK thread before continuing', async () => {
  const cleanups: string[] = [];
  Object.assign(window, { netcatty: { aiSdkAgentCleanup: async (id: string) => { cleanups.push(id); return { ok: true }; } } });
  save([{ ...session(), agentId: 'codex', externalSessionId: 'local-native-thread' }]);
  const incoming = { ...session(), agentId: 'codex', updatedAt: 3, externalSessionId: 'remote-native-thread' };
  incoming.messages.push({ id: 'remote-turn', role: 'user', content: 'Added on another device', timestamp: 3 });
  await applySyncPayload({ ...vault, aiSessions: [incoming], syncedAt: 2 }, { importVaultData: () => undefined });
  assert.deepEqual(cleanups, ['chat']);
  assert.equal(getAISessionsSnapshot().sessions[0].externalSessionId, undefined);
  assert.equal(getAISessionsSnapshot().sessions[0].messages.at(-1)?.content, 'Added on another device');
  delete (window as unknown as { netcatty?: unknown }).netcatty;
});
