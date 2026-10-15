import assert from 'node:assert/strict';
import test from 'node:test';

import type { SyncPayload } from '../domain/sync.ts';

const localStorageValues = new Map<string, string>();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
    removeItem: (key: string) => localStorageValues.delete(key),
    clear: () => localStorageValues.clear(),
  },
});

const {
  applyProtectedSyncPayload,
  readInterruptedVaultApply,
} = await import('./localVaultBackups.ts');

function emptyPayload(): SyncPayload {
  return {
    hosts: [],
    keys: [],
    snippets: [],
    customGroups: [],
    syncedAt: 1,
  };
}

test.beforeEach(() => {
  localStorageValues.clear();
});

test('protected apply preparation failure does not leave a partial-apply sentinel', async () => {
  let snapshotBuilt = false;

  await assert.rejects(
    () => applyProtectedSyncPayload({
      buildPreApplyPayload: () => {
        snapshotBuilt = true;
        return emptyPayload();
      },
      prepareApply: async () => {
        throw new Error('replica unavailable');
      },
      translateProtectiveBackupFailure: (message) => message,
    }),
    /replica unavailable/,
  );

  assert.equal(snapshotBuilt, false);
  assert.equal(readInterruptedVaultApply(), null);
});

test('prepared apply callback runs after the snapshot with sentinel protection', async () => {
  const calls: string[] = [];
  let observedSentinel = false;

  await applyProtectedSyncPayload({
    buildPreApplyPayload: () => {
      calls.push('snapshot');
      return emptyPayload();
    },
    prepareApply: async () => {
      calls.push('prepare');
      return async () => {
        calls.push('apply');
        observedSentinel = readInterruptedVaultApply() !== null;
      };
    },
    translateProtectiveBackupFailure: (message) => message,
  });

  assert.deepEqual(calls, ['prepare', 'snapshot', 'apply']);
  assert.equal(observedSentinel, true);
  assert.equal(readInterruptedVaultApply(), null);
});

for (const localRestore of [false, true]) {
  for (const encryptionFails of [false, true]) {
    test(`protected header preparation (${localRestore ? 'restore' : 'sync'}, ${encryptionFails ? 'failure' : 'success'})`, async () => {
      const { prepareSyncPayloadApply, prepareLocalVaultPayloadApply } = await import('./syncPayload.ts');
      const { STORAGE_KEY_THEME, STORAGE_KEY_AI_PROVIDERS } = await import('../infrastructure/config/storageKeys.ts');
      const sealed = `enc:v1:${Buffer.concat([Buffer.from('v10'), Buffer.alloc(32, 4)]).toString('base64')}`;
      const calls: string[] = [];
      Object.defineProperty(globalThis, 'window', { configurable: true, value: {
        netcatty: { credentialsEncrypt: async () => {
          calls.push('encrypt');
          assert.equal(readInterruptedVaultApply(), null);
          if (encryptionFails) throw new Error('keychain locked');
          return sealed;
        } },
        dispatchEvent: () => true,
      } });
      localStorageValues.set(STORAGE_KEY_THEME, 'light');
      const payload: SyncPayload = { ...emptyPayload(), settings: {
        theme: 'dark', ai: { providers: [{ id: 'custom', customHeaders: { 'X-Tenant': 'secret' } }] },
      } };
      const original = JSON.stringify(payload);
      const importers = { importVaultData: () => {
        calls.push('import');
        assert.notEqual(readInterruptedVaultApply(), null);
      } };
      const applying = applyProtectedSyncPayload({
        buildPreApplyPayload: () => { calls.push('snapshot'); return emptyPayload(); },
        prepareApply: () => localRestore
          ? prepareLocalVaultPayloadApply(payload, importers, { prepareConvergentRestore: async () => {
            calls.push('prepareReplica');
            return async () => { calls.push('commitReplica'); };
          } })
          : prepareSyncPayloadApply(payload, importers),
        translateProtectiveBackupFailure: (message) => message,
      });
      if (encryptionFails) {
        await assert.rejects(applying);
        assert.deepEqual(calls, ['encrypt']);
        assert.equal(localStorageValues.get(STORAGE_KEY_THEME), 'light');
        assert.equal(localStorageValues.has(STORAGE_KEY_AI_PROVIDERS), false);
      } else {
        await applying;
        assert.deepEqual(calls, localRestore
          ? ['encrypt', 'prepareReplica', 'snapshot', 'import', 'commitReplica']
          : ['encrypt', 'snapshot', 'import']);
        assert.equal(localStorageValues.get(STORAGE_KEY_THEME), 'dark');
        assert.equal(JSON.parse(localStorageValues.get(STORAGE_KEY_AI_PROVIDERS)!)[0].customHeaders['X-Tenant'], sealed);
      }
      assert.equal(readInterruptedVaultApply(), null);
      assert.equal(JSON.stringify(payload), original);
    });
  }
}
