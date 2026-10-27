import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { PluginAuthorRow } from '../../plugins/PluginAuthorRow';
import { I18nProvider } from '../../../application/i18n/I18nProvider';

const entry = { id: 'com.netcatty.starter', name: 'Starter', author: 'Netcatty', version: '0.1.2',
  repository: 'binaricat/Netcatty', commit: 'a'.repeat(40), selectionToken: 'b'.repeat(64),
  manifest: { publisher: 'netcatty' } } as NetcattyPluginCatalogEntry;
const identity = { author: 'Netcatty', avatar: 'data:image/png;base64,eA==', officialMaintained: true,
  sourceId: 'official', version: entry.version, archiveSha256: null };

test('untrusted entry strings and absent imagery produce a compact placeholder without an official badge', () => {
  const claimed = { ...entry, author: '<img src="https://avatars.githubusercontent.com/u/1">',
    officialMaintained: true, avatar: 'https://avatars.githubusercontent.com/u/1' };
  const html = renderToStaticMarkup(<I18nProvider locale="en"><PluginAuthorRow entry={claimed} /></I18nProvider>);
  assert.match(html, /data-plugin-author-placeholder/);
  assert.doesNotMatch(html, /<img|data-plugin-official-maintainer/);
  assert.match(html, /&lt;img/);
  assert.match(html, /items-center/);
});

test('mounted author rows load only when visible, retain fallbacks, cancel stale results and show a borderless themed maintainer pill', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const observers: Array<{ target: Element | null; callback: IntersectionObserverCallback }> = [];
  class VisibilityObserver {
    record: typeof observers[number];
    constructor(callback: IntersectionObserverCallback) { this.record = { callback, target: null }; observers.push(this.record); }
    observe(target: Element) { this.record.target = target; }
    disconnect() { this.record.target = null; }
  }
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('IntersectionObserver', VisibilityObserver);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  const calls: NetcattyPluginAuthorRequest[] = [];
  const pending: Array<(value: NetcattyPluginAuthorPresentation | null) => void> = [];
  Object.assign(window, { netcatty: { getPluginAuthorPresentation: (request: NetcattyPluginAuthorRequest) => {
    calls.push(request); return new Promise((resolve) => pending.push(resolve));
  } } });
  const render = async (value = entry, sourceId = 'official') => {
    await act(async () => root.render(<I18nProvider locale="en"><PluginAuthorRow entry={value} sourceId={sourceId} /></I18nProvider>));
  };
  const visible = async () => {
    await act(async () => {
      for (const observer of [...observers]) if (observer.target) observer.callback([{ target: observer.target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
  };
  try {
    await render(); assert.equal(calls.length, 0); assert.ok(document.querySelector('[data-plugin-author-placeholder]'));
    await visible(); assert.deepEqual(calls[0], { kind: 'catalog', pluginId: entry.id, selectionToken: entry.selectionToken, sourceId: 'official' });
    assert.ok(document.querySelector('[data-plugin-author-placeholder]'), 'loading uses the default placeholder');
    await act(async () => pending.shift()!(identity));
    const image = document.querySelector('img')!;
    assert.equal(image.getAttribute('src'), identity.avatar); assert.equal(image.width, 20); assert.equal(image.height, 20);
    const badge = document.querySelector<HTMLElement>('[data-plugin-official-maintainer]')!;
    assert.equal(badge.textContent, 'Official maintainer'); assert.match(badge.title, /not a safety certification/);
    assert.ok(badge.classList.contains('border-0'));
    assert.ok(badge.classList.contains('bg-amber-500/15')); assert.ok(badge.classList.contains('dark:bg-amber-400/15'));
    assert.ok(badge.classList.contains('text-amber-800')); assert.ok(badge.classList.contains('dark:text-amber-300'));
    document.documentElement.classList.add('dark');
    assert.ok(document.querySelector('[data-plugin-author-row]')?.classList.contains('items-center'));
    await act(async () => image.dispatchEvent(new Event('error')));
    assert.equal(document.querySelector('img'), null); assert.ok(document.querySelector('[data-plugin-author-placeholder]'));
    assert.ok(document.querySelector('[data-plugin-official-maintainer]'), 'image failure does not alter maintenance identity');

    const next = { ...entry, selectionToken: 'c'.repeat(64) };
    await render(next); assert.equal(document.querySelector('[data-plugin-official-maintainer]'), null);
    await visible(); const stale = pending.shift()!;
    const copied = { ...entry, author: 'Community author', selectionToken: 'd'.repeat(64) };
    await render(copied, 'third-party:copy'); await visible();
    await act(async () => stale(identity));
    assert.equal(document.querySelector('[data-plugin-official-maintainer]'), null);
    assert.match(document.querySelector('[data-plugin-author-row]')!.textContent!, /Community author/);
    await act(async () => pending.shift()!({ ...identity, author: copied.author, sourceId: 'third-party:copy', officialMaintained: false, avatar: 'https://avatars.githubusercontent.com/u/1' }));
    assert.equal(document.querySelector('img'), null, 'renderer never uses a remote avatar URL');
    assert.equal(document.querySelector('[data-plugin-official-maintainer]'), null);

    await render({ ...entry, selectionToken: 'f'.repeat(64) }); await visible();
    await act(async () => pending.shift()!({ ...identity, avatar: null, officialMaintained: false }));
    assert.ok(document.querySelector('[data-plugin-author-placeholder]'));
    const installed = { id: entry.id, activeVersion: entry.version, archiveSha256: 'a'.repeat(64),
      source: { id: 'official', kind: 'official', origin: 'https://plugins.netcatty.app', name: 'Official' },
      manifest: entry.manifest, runtime: {} } as NetcattyInstalledPlugin;
    await act(async () => root.render(<I18nProvider locale="en"><PluginAuthorRow plugin={installed} /></I18nProvider>));
    await visible(); assert.deepEqual(calls.at(-1), { kind: 'installed', pluginId: installed.id });
    await act(async () => pending.shift()!({ ...identity, version: '9.0.0', archiveSha256: installed.archiveSha256! }));
    assert.equal(document.querySelector('[data-plugin-official-maintainer]'), null, 'a stale installed version cannot gain a badge');
    const count = calls.length;
    await act(async () => root.render(<I18nProvider locale="en"><PluginAuthorRow plugin={{ ...installed }} /></I18nProvider>));
    await visible(); assert.equal(calls.length, count, 'unchanged installed identity does not reload on a new object reference');

    await render({ ...entry, selectionToken: 'e'.repeat(64) }); await visible();
    const late = pending.shift()!;
    await act(async () => root.unmount());
    await act(async () => late(identity));
    assert.equal(document.querySelector('[data-plugin-author-row]'), null);
    assert.ok(observers.every((observer) => observer.target === null));
  } finally {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
