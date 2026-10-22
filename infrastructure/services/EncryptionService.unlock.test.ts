import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { SYNC_CONSTANTS, type MasterKeyConfig } from '../../domain/sync';
import { unlockMasterKey } from './EncryptionService';

// These fakes prove call counts and verified-key ownership, not cryptography or
// timing. Real encryption/rotation tests remain the integration gate.
function installCryptoFixture(t: TestContext) {
  const derivations: Array<{ key: CryptoKey; params: Pbkdf2Params }> = [];
  const exportedKeys: CryptoKey[] = [];
  const rawKeys = new Map<CryptoKey, ArrayBuffer>();
  const encoder = new TextEncoder();
  const salt = new Uint8Array([1, 2, 3, 4]);
  const identity = (password: string, bytes: Uint8Array, iterations: number) =>
    JSON.stringify([password, [...bytes], iterations]);
  const bytesOf = (value: BufferSource): Uint8Array => ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  const base64 = (value: string) => btoa(String.fromCharCode(...encoder.encode(value)));

  t.mock.method(crypto.subtle, 'importKey', async (
    format: string, raw: BufferSource, algorithm: string, extractable: boolean, usages: string[],
  ) => {
    assert.equal(format, 'raw');
    assert.equal(algorithm, 'PBKDF2');
    assert.equal(extractable, false);
    assert.deepEqual(usages, ['deriveBits', 'deriveKey']);
    return { fixturePassword: new TextDecoder().decode(bytesOf(raw)) } as unknown as CryptoKey;
  });
  t.mock.method(crypto.subtle, 'deriveKey', async (
    params: Pbkdf2Params, material: CryptoKey, algorithm: AesKeyGenParams,
    extractable: boolean, usages: string[],
  ) => {
    assert.equal(params.name, 'PBKDF2');
    assert.equal(params.hash, 'SHA-256');
    assert.deepEqual(algorithm, { name: 'AES-GCM', length: 256 });
    assert.equal(extractable, true);
    assert.deepEqual(usages, ['encrypt', 'decrypt']);
    const key = { fixtureSequence: derivations.length } as unknown as CryptoKey;
    const password = (material as unknown as { fixturePassword: string }).fixturePassword;
    rawKeys.set(key, encoder.encode(identity(password, bytesOf(params.salt), params.iterations)).buffer as ArrayBuffer);
    derivations.push({ key, params });
    return key;
  });
  t.mock.method(crypto.subtle, 'exportKey', async (format: string, key: CryptoKey) => {
    assert.equal(format, 'raw');
    exportedKeys.push(key);
    assert.ok(rawKeys.has(key));
    return rawKeys.get(key)!;
  });
  t.mock.method(crypto.subtle, 'digest', async (algorithm: string, data: BufferSource) => {
    assert.equal(algorithm, 'SHA-256');
    // Identity digest is deliberately not a crypto implementation.
    return bytesOf(data).slice().buffer;
  });
  const makeConfig = (storedIterations?: number): MasterKeyConfig => ({
    salt: btoa(String.fromCharCode(...salt)),
    verificationHash: base64(identity('fixture-password', salt, storedIterations || SYNC_CONSTANTS.PBKDF2_ITERATIONS)),
    kdf: 'PBKDF2',
    kdfIterations: storedIterations as number,
    createdAt: 1,
  });
  return { derivations, exportedKeys, salt, makeConfig };
}

test('unlock derives once and returns the exact verified key without caching across calls', async (t) => {
  const fixture = installCryptoFixture(t);
  const config = fixture.makeConfig();
  const first = await unlockMasterKey('fixture-password', config);
  assert.ok(first);
  assert.equal(fixture.derivations.length, 1);
  assert.equal(first.derivedKey, fixture.exportedKeys[0]);
  assert.equal(first.derivedKey, fixture.derivations[0].key);
  assert.deepEqual(first.salt, fixture.salt);
  assert.equal(typeof first.unlockedAt, 'number');
  const second = await unlockMasterKey('fixture-password', config);
  assert.ok(second);
  assert.equal(fixture.derivations.length, 2);
  assert.notEqual(second.derivedKey, first.derivedKey);
  assert.equal(second.derivedKey, fixture.exportedKeys[1]);
});

for (const iterations of [undefined, 0, 123456, SYNC_CONSTANTS.PBKDF2_ITERATIONS]) {
  test(`unlock preserves stored iteration/fallback behavior: ${iterations}`, async (t) => {
    const fixture = installCryptoFixture(t);
    const result = await unlockMasterKey('fixture-password', fixture.makeConfig(iterations));
    assert.ok(result);
    assert.equal(fixture.derivations.length, 1);
    assert.equal(fixture.derivations[0].params.iterations, iterations || SYNC_CONSTANTS.PBKDF2_ITERATIONS);
  });
}

for (const scenario of ['password', 'hash', 'salt', 'iterations'] as const) {
  test(`unlock rejects mismatched ${scenario} without returning a key`, async (t) => {
    const fixture = installCryptoFixture(t);
    const config = fixture.makeConfig();
    if (scenario === 'hash') config.verificationHash = 'tampered';
    if (scenario === 'salt') config.salt = btoa('other-salt');
    if (scenario === 'iterations') config.kdfIterations = (config.kdfIterations || SYNC_CONSTANTS.PBKDF2_ITERATIONS) + 1;
    const result = await unlockMasterKey(scenario === 'password' ? 'wrong-password' : 'fixture-password', config);
    assert.equal(result, null);
    assert.equal(fixture.derivations.length, 1);
  });
}

test('unlock preserves null on malformed base64 salt', async (t) => {
  const fixture = installCryptoFixture(t);
  assert.equal(await unlockMasterKey('fixture-password', { ...fixture.makeConfig(), salt: '%%%' }), null);
  assert.equal(fixture.derivations.length, 0);
});

for (const method of ['importKey', 'deriveKey', 'exportKey', 'digest'] as const) {
  test(`unlock preserves null when ${method} rejects`, async (t) => {
    const fixture = installCryptoFixture(t);
    t.mock.method(crypto.subtle, method, async () => { throw new Error('fixture crypto rejection'); });
    assert.equal(await unlockMasterKey('fixture-password', fixture.makeConfig()), null);
  });
}
