import test from 'node:test';
import assert from 'node:assert/strict';
import { EncryptionService } from '../EncryptionService';
import { unlockImpl } from './stateAndSecurityMethods';

for (const scenario of ['rotated-valid-password', 'rotated-invalid-old-password', 'locked-during-unlock'] as const) {
  test(`unlock rejects a superseded request instead of reporting a bad password: ${scenario}`, async () => {
    const oldConfig = await EncryptionService.createMasterKeyConfig('old-fixture-password');
    const newConfig = await EncryptionService.createMasterKeyConfig('new-fixture-password');
    let generation = 0;
    const manager = {
      state: { masterKeyConfig: oldConfig, securityState: 'LOCKED', unlockedKey: null },
      getSyncSecurityGeneration: () => generation,
    };
    const pending = unlockImpl.call(manager,
      scenario === 'rotated-invalid-old-password' ? 'new-fixture-password' : 'old-fixture-password');
    if (scenario !== 'locked-during-unlock') manager.state.masterKeyConfig = newConfig;
    generation += 1;
    await assert.rejects(pending, /changed while unlocking/i);
    assert.equal(manager.state.securityState, 'LOCKED');
    assert.equal(manager.state.unlockedKey, null);
  });
}

test('a wrong password for the current configuration remains an ordinary verification failure', async () => {
  const config = await EncryptionService.createMasterKeyConfig('correct-fixture-password');
  const manager = { state: { masterKeyConfig: config, securityState: 'LOCKED', unlockedKey: null } };
  assert.equal(await unlockImpl.call(manager, 'wrong-fixture-password'), false);
  assert.equal(manager.state.unlockedKey, null);
});

// No real KDF in these ownership cases. The service's per-call key reuse must
// not change the manager's existing generation/config checks after await.
for (const outcome of ['valid', 'invalid'] as const) {
  for (const change of ['rotate', 'remove', 'generation'] as const) {
    test(`mocked pending unlock cannot publish after ${change}: ${outcome}`, async (t) => {
      const config = { verificationHash: 'fixture', salt: 'AQ==', kdf: 'PBKDF2' as const, kdfIterations: 600000, createdAt: 1 };
      const key = { derivedKey: {} as CryptoKey, salt: new Uint8Array([1]), unlockedAt: 1 };
      let resolve!: (value: typeof key | null) => void;
      t.mock.method(EncryptionService, 'unlockMasterKey', () => new Promise<typeof key | null>((done) => { resolve = done; }));
      let generation = 0;
      let events = 0;
      let syncStarts = 0;
      const manager = {
        state: {
          masterKeyConfig: config as typeof config | null,
          securityState: 'LOCKED', unlockedKey: null as typeof key | null, autoSyncEnabled: true,
        },
        masterPassword: null as string | null,
        getSyncSecurityGeneration: () => generation,
        emit: () => { events += 1; },
        startAutoSync: () => { syncStarts += 1; },
      };
      const pending = unlockImpl.call(manager, 'fixture-password');
      if (change === 'rotate') manager.state.masterKeyConfig = { ...config, salt: 'Ag==' };
      if (change === 'remove') {
        manager.state.masterKeyConfig = null;
        manager.state.securityState = 'NO_KEY';
      }
      if (change === 'generation') generation += 1;
      resolve(outcome === 'valid' ? key : null);
      await assert.rejects(pending, /changed while unlocking/i);
      assert.equal(manager.state.unlockedKey, null);
      assert.equal(manager.masterPassword, null);
      assert.equal(events, 0);
      assert.equal(syncStarts, 0);
    });
  }
}

test('mocked concurrent same-config unlock keeps the already-installed winner', async (t) => {
  const config = { verificationHash: 'fixture', salt: 'AQ==', kdf: 'PBKDF2' as const, kdfIterations: 600000, createdAt: 1 };
  const winner = { derivedKey: {} as CryptoKey, salt: new Uint8Array([1]), unlockedAt: 1 };
  const loser = { ...winner, derivedKey: {} as CryptoKey };
  let resolve!: (value: typeof loser) => void;
  const unlock = t.mock.method(EncryptionService, 'unlockMasterKey', () => new Promise<typeof loser>((done) => { resolve = done; }));
  const manager = {
    state: { masterKeyConfig: config, securityState: 'LOCKED', unlockedKey: null as typeof winner | null },
    masterPassword: null as string | null,
    getSyncSecurityGeneration: () => 0,
    emit: () => { assert.fail('losing unlock must not emit'); },
  };
  const pending = unlockImpl.call(manager, 'fixture-password');
  manager.state.securityState = 'UNLOCKED';
  manager.state.unlockedKey = winner;
  manager.masterPassword = 'winner-password';
  resolve(loser);
  assert.equal(await pending, true);
  assert.equal(manager.state.unlockedKey, winner);
  assert.equal(manager.masterPassword, 'winner-password');
  assert.equal(await unlockImpl.call(manager, 'another-password'), true);
  assert.equal(unlock.mock.callCount(), 1, 'already-unlocked requests must not derive');
});
