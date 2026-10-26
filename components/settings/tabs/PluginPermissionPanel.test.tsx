import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('permission panel refreshes real grants, revokes once, and keeps stale reads from replacing new results', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../../application/i18n/I18nProvider');
  const { PluginPermissionPanel } = await import('./PluginPermissionPanel');
  const root = createRoot(document.getElementById('root')!);
  const initial = {
    grants: [{ permission: 'network', resource: 'https://synthetic.invalid/<text>', resourceKind: 'exact', scope: 'always' as const, sessionId: null, grantedAt: 1, matchesCurrentActivation: false }],
    audit: [{ event: 'permission.used', createdAt: 2, permission: 'network' }],
  };
  let reads = 0;
  let revokes = 0;
  let changed = 0;
  let staleRead: (value: typeof initial) => void = () => {};
  let releaseRevoke: () => void = () => {};
  const revokePending = new Promise<void>((resolve) => { releaseRevoke = resolve; });
  Object.assign(dom.window, { netcatty: {
    async getPluginPermissions(id: string) {
      assert.equal(id, 'com.example.synthetic');
      reads++;
      if (reads === 2) return new Promise<typeof initial>((resolve) => { staleRead = resolve; });
      return reads > 2 ? { grants: [], audit: [] } : initial;
    },
    async revokePluginPermissions(id: string) { assert.equal(id, 'com.example.synthetic'); revokes++; await revokePending; },
  } });
  const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent === text)!;
  try {
    await act(async () => root.render(<I18nProvider locale="en"><PluginPermissionPanel pluginId="com.example.synthetic" onChanged={async () => { changed++; }} /></I18nProvider>));
    assert.match(document.body.textContent!, /synthetic.invalid/);
    assert.equal(document.querySelector('text'), null, 'resource is rendered as plain text');
    assert.match(document.body.textContent!, /Until revoked/);
    assert.match(document.body.textContent!, /Inactive for the current activation/);
    await act(async () => { button('Refresh').click(); });
    await act(async () => {
      button('Disable and revoke all grants').click();
      button('Disable and revoke all grants').click();
    });
    assert.equal(revokes, 1);
    assert.equal(button('Refresh').disabled, true);
    await act(async () => { releaseRevoke(); });
    assert.equal(changed, 1);
    assert.match(document.body.textContent!, /No saved grants/);
    await act(async () => { staleRead(initial); });
    assert.doesNotMatch(document.body.textContent!, /synthetic.invalid/);
    Object.assign(dom.window, { netcatty: { async getPluginPermissions() { throw new Error('synthetic read failed'); } } });
    await act(async () => { button('Refresh').click(); });
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /synthetic read failed/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
