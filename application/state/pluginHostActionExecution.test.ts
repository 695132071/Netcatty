import assert from 'node:assert/strict';
import test from 'node:test';
import { executePluginHostAction, type PluginHostAction, type PluginHostActionVault } from './pluginHostActionExecution';
import { PluginHostActionResources } from './pluginHostActionResources';
import type { Host } from '../../domain/models';

const synthetic: Host = { id: 'synthetic', label: 'Synthetic', hostname: 'synthetic.invalid', username: 'test', tags: [], os: 'linux', password: 'synthetic-only', startupCommand: 'synthetic-script' };

function fixture() {
  const resources = new PluginHostActionResources();
  let active = true, authorized = 0, connections = 0, writes = 0;
  let beforeRead: (() => void) | undefined;
  let beforeCommit: (() => void) | undefined;
  let duringAuthorize: (() => void) | undefined;
  const vault: PluginHostActionVault = {
    hosts: [synthetic], customGroups: [], groupConfigs: [], snippets: [], isInitialized: true,
    async readPersistedHosts() { beforeRead?.(); return [structuredClone(synthetic)]; },
    async commitVaultImportTransaction(next, groups, sources, _configs, _expected, _lock, authorize) {
      beforeCommit?.();
      await authorize?.();
      writes++; vault.hosts = next;
      return { status: 'persisted', groups: groups([]), sources: sources([]), groupConfigs: [] };
    },
  };
  resources.observe(vault.hosts);
  const target = resources.metadata(synthetic.id);
  const options = {
    getVault: () => vault, resources,
    assertCurrent() { if (!active) throw new Error('Action cancelled'); },
    async authorizeCommit() { duringAuthorize?.(); if (!active) throw new Error('Action revoked'); authorized++; },
    connect(host: Host) { assert.equal(host, synthetic); connections++; return 'private-session-id'; },
  };
  return { vault, target, options, get authorized() { return authorized; }, get connections() { return connections; }, get writes() { return writes; },
    cancel() { active = false; }, beforeRead(fn: () => void) { beforeRead = fn; }, beforeCommit(fn: () => void) { beforeCommit = fn; }, duringAuthorize(fn: () => void) { duringAuthorize = fn; },
  };
}

test('reviewed connection dispatches through existing handler and returns no session data', async () => {
  const f = fixture();
  assert.equal(await executePluginHostAction({ kind: 'connect', target: f.target }, f.options), 'requested');
  assert.equal(f.authorized, 1); assert.equal(f.connections, 1); assert.equal(f.writes, 0);
});

test('host edit preserves credentials and scripts and claims action authority after preparation', async () => {
  const f = fixture();
  assert.equal(await executePluginHostAction({ kind: 'edit', target: f.target, draft: { label: 'Reviewed' } }, f.options), 'saved');
  assert.equal(f.vault.hosts[0].password, synthetic.password);
  assert.equal(f.vault.hosts[0].startupCommand, synthetic.startupCommand);
  assert.equal(f.vault.hosts[0].label, 'Reviewed');
  assert.equal(f.authorized, 1); assert.equal(f.writes, 1); assert.equal(f.connections, 0);
});

for (const point of ['beforeRead', 'beforeCommit', 'duringAuthorize'] as const) test(`cancel/revoke at ${point} prevents the Vault write`, async () => {
  const f = fixture(); f[point](() => f.cancel());
  await assert.rejects(executePluginHostAction({ kind: 'edit', target: f.target, draft: { label: 'Never saved' } }, f.options), /cancelled|revoked/);
  assert.equal(f.writes, 0); assert.equal(f.connections, 0);
});

for (const change of ['remove', 'replace', 'scripts', 'locked'] as const) test(`${change} during awaited connection preparation prevents dispatch`, async () => {
  const f = fixture();
  f.beforeRead(() => {
    if (change === 'remove') f.vault.hosts = [];
    if (change === 'replace') f.vault.hosts = [{ ...synthetic }];
    if (change === 'scripts') f.vault.snippets = [];
    if (change === 'locked') f.cancel();
  });
  await assert.rejects(executePluginHostAction({ kind: 'connect', target: f.target }, f.options));
  assert.equal(f.authorized, 0); assert.equal(f.connections, 0);
});

test('create produces a saved SSH draft without executable or credential injection', async () => {
  const f = fixture();
  const action: PluginHostAction = { kind: 'create', draft: { hostname: 'new.invalid', label: 'New', group: 'Synthetic', password: 'untrusted', startupCommand: 'untrusted' } as never };
  assert.equal(await executePluginHostAction(action, f.options), 'saved');
  const created = f.vault.hosts[1];
  assert.notEqual(created.id, synthetic.id);
  assert.equal(created.password, undefined); assert.equal(created.startupCommand, undefined);
});
