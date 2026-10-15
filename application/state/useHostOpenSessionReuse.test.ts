import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { Host, Identity, SSHKey, TerminalSession } from '../../domain/models';
import { updateRestoredSessionStatusState } from './sessionRestoreState';
import { resolveTerminalSessionHost } from '../../domain/terminalHostResolution';
import { createHostTerminalSession } from './sessionFactories';
import { useHostOpenSessionReuse } from './useHostOpenSessionReuse';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const effective = (host: Host) => host;
const host = (extra: Partial<Host> = {}): Host => ({
  id: 'host', hostname: 'original.invalid', username: 'user', label: 'Original', os: 'linux', tags: [], protocol: 'ssh', ...extra,
});

async function harness(initial: Host, extra: { hosts?: Host[]; keys?: SSHKey[]; identities?: Identity[]; sessions?: TerminalSession[] } = {}) {
  let hosts = [initial, ...(extra.hosts ?? [])];
  let keys = extra.keys ?? [];
  let identities = extra.identities ?? [];
  let sessions: TerminalSession[] = extra.sessions ?? [{ ...createHostTerminalSession('tab', initial), status: 'connected' }];
  let find: ReturnType<typeof useHostOpenSessionReuse>;
  function Harness() {
    find = useHostOpenSessionReuse({ sessions, hosts, keys, identities, resolveEffectiveHost: effective });
    return null;
  }
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(Harness)); });
  return {
    find: () => find(initial.id),
    async update(input: { host?: Host; hosts?: Host[]; keys?: SSHKey[]; identities?: Identity[]; sessions?: TerminalSession[] }) {
      hosts = input.hosts ?? (input.host ? [input.host, ...hosts.slice(1)] : hosts);
      keys = input.keys ?? keys;
      identities = input.identities ?? identities;
      sessions = input.sessions ?? sessions;
      await act(async () => renderer.update(React.createElement(Harness)));
    },
    close: () => act(async () => renderer.unmount()),
  };
}

for (const [field, value] of [
  ['hostname', 'replacement.invalid'], ['username', 'other-user'], ['port', 2222],
  ['protocol', 'telnet'], ['password', 'new-password'], ['authMethod', 'key'],
  ['hostChain', { hostIds: ['jump'] }],
  ['proxyConfig', { type: 'socks5', host: 'proxy.invalid', port: 1080 }],
] as const) {
  test(`a saved ${field} edit cannot reuse the old tab`, async (t) => {
    const original = host({ password: 'old-password', authMethod: 'password' });
    const api = await harness(original, { hosts: [host({ id: 'jump', hostname: 'jump.invalid' })] });
    t.after(api.close);
    assert.equal((await api.find())?.sessionId, 'tab');
    await api.update({ host: { ...original, [field]: value } });
    assert.equal(await api.find(), undefined);
  });
}

test('renaming the target and jump host keeps the same tab eligible', async (t) => {
  const original = host({ hostChain: { hostIds: ['jump'] } });
  const jump = host({ id: 'jump', hostname: 'jump.invalid' });
  const api = await harness(original, { hosts: [jump] });
  t.after(api.close);
  await api.update({ hosts: [{ ...original, label: 'Renamed', fontSize: 16, notes: 'Updated note' }, { ...jump, label: 'Renamed jump' }] });
  assert.equal((await api.find())?.sessionId, 'tab');
});

test('changing a jump endpoint or its password rejects the original connection', async (t) => {
  const original = host({ hostChain: { hostIds: ['jump'] } });
  const jump = host({ id: 'jump', hostname: 'jump.invalid', password: 'old' });
  const api = await harness(original, { hosts: [jump] });
  t.after(api.close);
  for (const changed of [{ ...jump, hostname: 'new-jump.invalid' }, { ...jump, password: 'new' }]) {
    await api.update({ hosts: [original, changed] });
    assert.equal(await api.find(), undefined);
  }
});

test('rotating a referenced identity or key keeps stable IDs from masking auth changes', async (t) => {
  const identity: Identity = { id: 'identity', label: 'Login', username: 'user', password: 'old', authMethod: 'password', created: 0 };
  const original = host({ identityId: identity.id });
  const api = await harness(original, { identities: [identity] });
  t.after(api.close);
  assert.equal((await api.find())?.sessionId, 'tab');
  await api.update({ identities: [{ ...identity, password: 'rotated' }] });
  assert.equal(await api.find(), undefined);
  const key: SSHKey = { id: 'key', label: 'Key', type: 'ED25519', privateKey: 'old-key', source: 'generated', category: 'key', created: 0 };
  const keyHost = host({ identityFileId: key.id, authMethod: 'key' });
  const keyApi = await harness(keyHost, { keys: [key] });
  t.after(keyApi.close);
  assert.equal((await keyApi.find())?.sessionId, 'tab');
  await keyApi.update({ keys: [{ ...key, privateKey: 'rotated-key' }] });
  assert.equal(await keyApi.find(), undefined);
});

for (const [field, value] of [
  ['baudRate', 19200], ['dataBits', 7], ['stopBits', 2], ['parity', 'even'], ['flowControl', 'rts/cts'],
] as const) {
  test(`a serial ${field} edit must not reuse the opening parameters`, async (t) => {
    const original = host({ protocol: 'serial', hostname: '/dev/tty.test', username: '', serialConfig: { path: '/dev/tty.test', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' } });
    const api = await harness(original);
    t.after(api.close);
    assert.equal((await api.find())?.sessionId, 'tab');
    await api.update({ host: { ...original, serialConfig: { ...original.serialConfig!, [field]: value } } });
    assert.equal(await api.find(), undefined);
  });
}

test('unchanged legacy serial defaults still match their opening snapshot', async (t) => {
  const original = host({ protocol: 'serial', hostname: '/dev/tty.test', username: '', port: 9600 });
  const api = await harness(original);
  t.after(api.close);
  assert.equal((await api.find())?.sessionId, 'tab');
});

test('the captured serial settings come from the opening session even if the vault was already edited', async (t) => {
  const original = host({ protocol: 'serial', hostname: '/dev/tty.test', username: '', serialConfig: { path: '/dev/tty.test', baudRate: 9600 } });
  const session: TerminalSession = { ...createHostTerminalSession('tab', original), status: 'connected' };
  const api = await harness({ ...original, serialConfig: { ...original.serialConfig!, baudRate: 19200 } }, { sessions: [session] });
  t.after(api.close);
  assert.equal(await api.find(), undefined);
});

for (const changedField of ['configuration', 'credentialId'] as const) {
  test(`a restored plugin tab keeps its opening ${changedField} after manual reconnect`, async (t) => {
    const providerId = 'com.example.transport.connection';
    const original = host({ protocol: `plugin:${providerId}`, pluginConnection: { providerId, configuration: { endpoint: 'original.invalid' }, credentialId: 'original-credential-reference' } });
    const edited = { ...original, pluginConnection: { ...original.pluginConnection!, [changedField]: changedField === 'configuration' ? { endpoint: 'replacement.invalid' } : 'replacement-credential-reference' } };
    const restored: TerminalSession = { ...createHostTerminalSession('tab', original), status: 'disconnected', restoreState: 'restored-disconnected' };
    const api = await harness(edited, { sessions: [restored] });
    t.after(api.close);
    assert.equal(await api.find(), undefined);
    const reconnecting = updateRestoredSessionStatusState([restored], restored.id, 'connecting');
    const actual = resolveTerminalSessionHost({ session: reconnecting[0], hosts: [edited], groupConfigs: [], proxyProfiles: [], localOs: 'linux' });
    assert.deepEqual(actual.pluginConnection, original.pluginConnection, 'the real terminal resolver uses the restored opening configuration');
    await api.update({ sessions: reconnecting });
    assert.equal(await api.find(), undefined, 'host_open must not call that old transport the edited vault connection');
  });
}

test('an unchanged restored plugin configuration can be reused after manual reconnect', async (t) => {
  const providerId = 'com.example.transport.connection';
  const original = host({ protocol: `plugin:${providerId}`, pluginConnection: { providerId, configuration: { endpoint: 'original.invalid' } } });
  const restored: TerminalSession = { ...createHostTerminalSession('tab', original), status: 'disconnected', restoreState: 'restored-disconnected' };
  const api = await harness({ ...original, label: 'Renamed' }, { sessions: [restored] });
  t.after(api.close);
  await api.update({ sessions: updateRestoredSessionStatusState([restored], restored.id, 'connecting') });
  assert.equal((await api.find())?.sessionId, 'tab');
});
