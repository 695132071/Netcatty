import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

async function fixture() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'DocumentFragment', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent']) install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  install('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  install('cancelAnimationFrame', (id: number) => frames.delete(id));
  const scrolled: HTMLElement[] = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../../application/i18n/I18nProvider');
  const { Tabs } = await import('../../ui/tabs');
  const { default: SettingsPluginsTab } = await import('./SettingsPluginsTab');
  const plugin = { id: 'com.example.alpha', enabled: true, activeVersion: '1.0.0', archiveSha256: 'a'.repeat(64),
    source: { id: 'local', kind: 'local', name: 'Local import', origin: null },
    manifest: { manifestVersion: 1, id: 'com.example.alpha', name: 'Alpha', version: '1.0.0', publisher: 'example', engines: { netcatty: '>=0.0.0', api: '>=0.1.0-internal <0.2.0' }, main: { browser: 'index.js' }, contributes: { settings: [{ id: 'com.example.alpha.setting', label: 'Alpha setting', control: 'text', scope: 'application' }] } },
    runtime: { status: 'stopped', kind: null, lastError: null, quarantinedAt: null } };
  let installed = plugin;
  let delayed = false;
  const pending: (() => void)[] = [];
  const listeners = new Set<() => void>();
  Object.assign(dom.window, { netcatty: {
    async getPluginRuntimeStatus() { return { available: true, experimental: true, credentialStorageAvailable: true }; },
    async listPlugins() { return [installed]; },
    onPluginContributionsChanged(callback: () => void) { listeners.add(callback); return () => listeners.delete(callback); },
    async getPluginLogStatus() { return { saveToDisk: false, verbose: false, droppedRecords: 0, writeErrors: 0, pendingBytes: 0, maxBytes: 3145728, retentionDays: 7 }; },
    async getPluginContributions(query: NetcattyPluginContributionQuery) {
      if (delayed && query.scopeIds) await new Promise<void>((resolve) => pending.push(resolve));
      return { locale: 'en', plugins: [{ id: plugin.id, version: '1.0.0', displayName: 'Alpha', commands: [], keybindings: [], menus: [], views: [], settings: [{ id: 'com.example.alpha.setting', label: 'Alpha setting', control: 'text', scope: 'application', scopeId: 'application', value: 'synthetic', visible: true, configured: true }] }] };
    },
    async getPluginScopeCatalog() { return { workspace: [], host: [], session: [], device: [] }; },
    async listPluginSources() { return []; },
    async listPluginCatalog() { return { entries: [], source: 'builtin', error: null }; },
    async getPluginPermissions() { return { grants: [], audit: [] }; },
  } });
  const root = createRoot(document.getElementById('root')!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
  const perform = async (action: () => void) => { await act(async () => { action(); await settle(); }); };
  await perform(() => root.render(<I18nProvider locale="en"><Tabs defaultValue="plugins"><SettingsPluginsTab /></Tabs></I18nProvider>));
  const gear = document.querySelector<HTMLButtonElement>('button[aria-label="Settings for Alpha"]')!;
  assert.ok(gear && !gear.disabled);
  const flushFrames = async (count = 3) => {
    for (let i = 0; i < count; i++) await act(async () => {
      const current = [...frames.values()]; frames.clear();
      for (const callback of current) callback(i * 16);
    });
  };
  return {
    gear, scrolled, perform, flushFrames,
    section: () => document.querySelector<HTMLElement>('section[aria-labelledby="plugin-settings-com.example.alpha"]'),
    open: async (slow = false) => { delayed = slow; await perform(() => { gear.focus(); gear.click(); }); },
    release: async () => { delayed = false; await perform(() => { for (const resolve of pending.splice(0)) resolve(); }); },
    selectTab: async (name: string) => {
      const tab = [...document.querySelectorAll<HTMLElement>('[role=dialog] [role=tab]')].find((element) => element.textContent?.startsWith(name))!;
      await perform(() => { tab.focus(); tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    },
    close: async () => { await perform(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); },
    replaceOwner: async () => { installed = { ...plugin, source: { ...plugin.source, id: 'third-party:replacement', kind: 'third-party' } }; await perform(() => window.dispatchEvent(new Event('netcatty:plugin-packages-changed'))); },
    refresh: async () => { await perform(() => { for (const callback of [...listeners]) callback(); }); },
    dispose: async () => {
      await act(async () => root.unmount()); dom.window.close();
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    },
  };
}

test('gear entry scrolls and focuses its settings once, after dialog autofocus', async () => {
  const f = await fixture();
  try {
    await f.open();
    assert.notEqual(document.activeElement, f.section());
    await f.flushFrames();
    assert.deepEqual(f.scrolled, [f.section()]);
    assert.equal(document.activeElement, f.section());
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Alpha setting"]')!;
    input.focus();
    await f.refresh(); await f.flushFrames();
    assert.equal(document.activeElement, input, 'later contribution refresh cannot steal focus');
    assert.equal(f.scrolled.length, 1);
    await f.close();
    assert.equal(document.activeElement, f.gear);
  } finally { await f.dispose(); }
});

test('gear entry waits for slow contributions before targeting the existing settings section', async () => {
  const f = await fixture();
  try {
    await f.open(true); await f.flushFrames();
    assert.equal(f.section(), null); assert.equal(f.scrolled.length, 0);
    await f.release(); await f.flushFrames();
    assert.equal(f.scrolled.length, 1); assert.equal(document.activeElement, f.section());
  } finally { await f.dispose(); }
});

test('closing between animation frames cancels an already scheduled gear focus', async () => {
  const f = await fixture();
  try {
    await f.open(); await f.flushFrames(1);
    await f.close(); await f.flushFrames();
    assert.equal(f.scrolled.length, 0);
    assert.equal(document.querySelector('[role=dialog]'), null);
    assert.equal(document.activeElement, f.gear);
  } finally { await f.dispose(); }
});

for (const cancellation of ['tab', 'plugin', 'owner', 'close']) test(`pending gear entry cancels on ${cancellation} change`, async () => {
  const f = await fixture();
  try {
    await f.open(true);
    if (cancellation === 'tab') await f.selectTab('Official');
    if (cancellation === 'plugin') await f.perform(() => document.querySelector<HTMLButtonElement>('[data-plugin-card="com.example.alpha"]')!.click());
    if (cancellation === 'owner') await f.replaceOwner();
    if (cancellation === 'close') await f.close();
    await f.release();
    if (cancellation === 'tab') await f.selectTab('Installed');
    if (cancellation === 'tab' || cancellation === 'plugin') await f.perform(() => document.querySelector<HTMLButtonElement>('[data-plugin-card="com.example.alpha"]')!.click());
    await f.flushFrames();
    assert.equal(f.scrolled.length, 0, 'late data or returning to the plugin cannot revive the cancelled intent');
    if (cancellation === 'close') {
      assert.equal(document.querySelector('[role=dialog]'), null);
      assert.equal(document.activeElement, f.gear);
    }
  } finally { await f.dispose(); }
});

test('normal Browse and detail entry retain their existing detail focus', async () => {
  const f = await fixture();
  try {
    const browse = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Browse')!;
    await f.perform(() => { browse.focus(); browse.click(); });
    await f.perform(() => document.querySelector<HTMLButtonElement>('[data-plugin-card="com.example.alpha"]')!.click());
    await f.flushFrames();
    assert.ok(f.section()); assert.equal(f.scrolled.length, 0);
    assert.equal(document.activeElement, document.querySelector('[data-plugin-detail]'));
    await f.close(); assert.equal(document.activeElement, browse);
  } finally { await f.dispose(); }
});
