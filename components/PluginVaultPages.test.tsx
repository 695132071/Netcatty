import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('Vault navigation mounts a real content slot, yields to host dialogs, and withdraws stale pages', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'Event']) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key as keyof Window] });
  }
  for (const [key, value] of Object.entries({ getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 200, y: 100, width: 640, height: 480, top: 100, left: 200, right: 840, bottom: 580, toJSON() {} });
  const { default: React, act, useState } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { usePluginVaultPages } = await import('../application/state/usePluginVaultPages');
  const { PluginVaultNavigation, PluginVaultPage } = await import('./plugins/PluginVaultPages');
  const { activeTabStore } = await import('../application/state/activeTabStore');
  const { requestOpenPluginView } = await import('../application/state/usePluginViewLifecycle');
  const { I18nProvider } = await import('../application/i18n/I18nProvider');
  const page = { id: 'com.example.page.main', title: 'Synthetic page', location: 'vault-page', entry: 'page.html', visible: true };
  let snapshot = { locale: 'en', plugins: [{ id: 'com.example.page', version: '1.0.0', displayName: 'Synthetic plugin', commands: [], keybindings: [], menus: [], settings: [], views: [page] }] };
  let changed: (() => void) | undefined;
  const listeners = new Set<(event: NetcattyPluginViewClosedEvent) => void>();
  const opens: NetcattyPluginViewOpenRequest[] = [], closes: string[] = [], visibility: boolean[] = [];
  let defer: ((value: { instanceId: string }) => void) | undefined;
  let deferOpen = false;
  let delayLayout = false;
  const rejectOldLayout: Array<(error: Error) => void> = [];
  const layoutResult = () => delayLayout ? new Promise<void>((_resolve, reject) => { rejectOldLayout.push(reject); }) : Promise.resolve();
  Object.assign(dom.window, { netcatty: {
    async getPluginRuntimeStatus() { return { available: true }; },
    async getPluginContributions() { return snapshot; },
    onPluginContributionsChanged(fn: () => void) { changed = fn; return () => { changed = undefined; }; },
    onPluginViewClosed(fn: (event: NetcattyPluginViewClosedEvent) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async openPluginView(payload: NetcattyPluginViewOpenRequest) { opens.push(payload); return deferOpen ? new Promise<{ instanceId: string }>((resolve) => { defer = resolve; }) : { instanceId: payload.instanceId! }; },
    async closePluginView(id: string) { closes.push(id); }, async setPluginViewBounds() { await layoutResult(); },
    async setPluginViewVisibility(_id: string, visible: boolean) { visibility.push(visible); await layoutResult(); },
  } });
  let selectSection!: (section: 'hosts' | `plugin-vault:${string}`) => void;
  function Fixture() {
    const [section, select] = useState<'hosts' | `plugin-vault:${string}`>('hosts'); selectSection = select;
    const model = usePluginVaultPages({ locale: 'en', section, select });
    return <><aside><button data-plugin-vault-fallback onClick={() => select('hosts')}>Hosts</button><PluginVaultNavigation model={model} collapsed={false} /></aside>
      <main data-section="vault-main">{model.selected ? <PluginVaultPage key={model.selected.key} model={model} /> : <p>Built-in hosts</p>}</main></>;
  }
  const root = createRoot(document.getElementById('root')!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 35));
  const clickPage = async () => { await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Synthetic page — Synthetic plugin"]')!.click(); await settle(); }); };
  try {
    activeTabStore.setActiveTabId('vault');
    await act(async () => { root.render(<I18nProvider locale="en"><Fixture /></I18nProvider>); await settle(); });
    assert.equal(opens.length, 0, 'catalog enumeration does not activate the plugin');
    await clickPage();
    assert.ok(document.querySelector('[data-section="vault-main"] [data-plugin-view-slot="vault-page"]'));
    assert.equal(opens.length, 1);
    assert.deepEqual(opens[0].context, { 'netcatty.surface': 'vault-page' }, 'no Vault/session data accompanies navigation');
    assert.equal(visibility.at(-1), true);
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    await act(async () => { document.body.append(dialog); await settle(); });
    assert.equal(visibility.at(-1), false, 'native content yields to host security/settings dialogs');
    await act(async () => { dialog.remove(); await settle(); });
    assert.equal(visibility.at(-1), true);
    await act(async () => { activeTabStore.setActiveTabId('terminal:synthetic'); assert.ok(closes.includes(opens[0].instanceId!)); await settle(); });
    await act(async () => { activeTabStore.setActiveTabId('vault'); await settle(); });
    assert.equal(opens.length, 2);
    await act(async () => { snapshot = { ...snapshot, plugins: [] }; changed?.(); await settle(); });
    await act(async () => { await settle(); });
    assert.ok(closes.includes(opens[1].instanceId!));
    assert.equal(document.querySelector('[data-plugin-vault-page]'), null);
    assert.equal(document.activeElement?.textContent, 'Hosts');
    await act(async () => { selectSection('plugin-vault:missing'); await settle(); });
    assert.match(document.querySelector('main')!.textContent!, /Built-in hosts/);
    await act(async () => { snapshot = { ...snapshot, plugins: [{ id: 'com.example.page', version: '1.0.0', displayName: 'Synthetic plugin', commands: [], keybindings: [], menus: [], settings: [], views: [page] }] }; changed?.(); await settle(); });
    deferOpen = true;
    await act(async () => { requestOpenPluginView({ viewId: page.id }); await settle(); });
    assert.equal(opens.length, 3);
    await act(async () => { selectSection('hosts'); await settle(); });
    assert.ok(closes.includes(opens[2].instanceId!), 'cancel reserved instance before its open response');
    await act(async () => { defer!({ instanceId: opens[2].instanceId! }); await settle(); });
    assert.equal(document.querySelector('[data-plugin-vault-page]'), null, 'late open cannot restore withdrawn page');
    assert.ok(closes.filter((id) => id === opens[2].instanceId).length >= 2, 'late native response is also closed');
    deferOpen = false;
    const second = { ...page, id: 'com.example.page.second', title: 'Second page' };
    await act(async () => { snapshot = { ...snapshot, plugins: [{ ...snapshot.plugins[0], views: [page, second] }] }; changed?.(); await settle(); });
    delayLayout = true;
    await clickPage();
    assert.ok(rejectOldLayout.length >= 2, 'old page has both bounds and visibility IPC in flight');
    await act(async () => { selectSection('hosts'); await settle(); });
    delayLayout = false;
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Second page — Synthetic plugin"]')!.click(); await settle(); });
    await act(async () => { for (const reject of rejectOldLayout) reject(new Error('old page layout failed')); await settle(); });
    assert.equal(document.querySelector('[data-plugin-vault-page]')?.getAttribute('aria-label'), 'Second page', 'old bounds/visibility failures cannot withdraw the newly selected page');
  } finally {
    await act(async () => { root.unmount(); await settle(); }); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
