import assert from 'node:assert/strict';
import test from 'node:test';
import React, { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { I18nProvider } from '../../../application/i18n/I18nProvider';
import { PluginMarketplaceContent } from './PluginMarketplace';
import type { usePluginCatalog } from '../../../application/state/usePluginCatalog';

const entries = ['Alpha', 'Beta'].map((name) => ({
  id: `com.example.${name.toLowerCase()}`, name, author: 'Example', version: '1.0.0', license: 'MIT',
  description: `${name} local utility`, repository: 'example/plugins', commit: 'a'.repeat(40),
  manifest: { manifestVersion: 1, id: `com.example.${name.toLowerCase()}`, name, version: '1.0.0', publisher: 'Example', engines: { netcatty: '>=1.0.0', api: '0.1.0-internal' }, main: { browser: 'index.js' }, permissions: { required: ['settings.read'] } },
})) as NetcattyPluginCatalogEntry[];
const catalog = {
  entries, source: 'registry', listStatus: 'ready', listError: null, readme: '# Author documentation', readmeStatus: 'ready', readmeError: null,
  error: null, busy: false, retryList() {}, retryReadme() {}, async install() {},
} as ReturnType<typeof usePluginCatalog>;

test('catalog keeps search during selection/back, switches detail, and displays real installed state', async () => {
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => { callback(0); return 0; };
  const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: ReactTestRenderer;
  function Harness() {
    const [selected, setSelected] = useState<string | null>(null);
    return <I18nProvider locale="en"><PluginMarketplaceContent catalog={catalog} selected={selected} onSelect={setSelected}
      installed={[{ id: entries[0].id, activeVersion: '0.9.0', enabled: false, runtime: { lastError: 'Incompatible with this host' } } as NetcattyInstalledPlugin]} /></I18nProvider>;
  }
  try {
    await act(async () => { renderer = create(<Harness />); });
    const cards = () => renderer.root.findAll((node) => node.type === 'button' && Boolean(node.props['data-plugin-id']));
    const input = () => renderer.root.findByType('input');
    assert.equal(cards().length, 2);
    await act(async () => input().props.onChange({ target: { value: 'Alpha' } }));
    assert.equal(cards().length, 1);
    await act(async () => cards()[0].props.onClick());
    assert.equal(renderer.root.findByType('article').props['aria-label'], 'Alpha');
    assert.equal(cards()[0].props['aria-current'], 'true');
    const detailText = JSON.stringify(renderer.toJSON());
    assert.match(detailText, /0.9.0/);
    assert.match(detailText, /Disabled/);
    assert.match(detailText, /Incompatible with this host/);
    assert.match(detailText, /Last recorded error/);
    assert.match(cards()[0].props.className, /bg-primary\/10/);
    assert.match(cards()[0].props.className, /border-primary\/40/);
    assert.doesNotMatch(cards()[0].props.className, /bg-accent|text-accent-foreground/);
    assert.match(detailText, /1 plugins/);
    assert.equal(renderer.root.findAllByType('details').length, 0, 'permissions are not hidden in a disclosure');
    assert.equal(renderer.root.findAll((node) => node.type === 'button' && node.children.includes('Install this version (disabled)')).length, 0, 'source-only cards have no install action');
    const back = () => renderer.root.findAllByType('button').find((node) => node.children.includes('All plugins'))!;
    await act(async () => back().props.onClick());
    assert.equal(renderer.root.findAllByType('article').length, 0);
    assert.equal(input().props.value, 'Alpha');
    await act(async () => input().props.onChange({ target: { value: '' } }));
    await act(async () => cards()[0].props.onClick());
    await act(async () => cards()[1].props.onClick());
    assert.equal(renderer.root.findByType('article').props['aria-label'], 'Beta');
    assert.equal(cards()[1].props['aria-current'], 'true');
    assert.equal(cards()[0].props['aria-current'], undefined);
    await act(async () => input().props.onChange({ target: { value: 'no match' } }));
    assert.equal(cards().length, 0);
    assert.equal(renderer.root.findByType('article').props['aria-label'], 'Beta', 'filtering does not erase the selected detail');
    await act(async () => back().props.onClick());
    assert.equal(input().props.value, 'no match');
    await act(async () => renderer.unmount());
  } finally {
    globalThis.requestAnimationFrame = previousRaf;
    actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});


test('README failure leaves the permissions and source visible, before the failure message', () => {
  const html = renderToStaticMarkup(<I18nProvider locale="en"><PluginMarketplaceContent
    catalog={{ ...catalog, readmeStatus: 'error', readme: null, readmeError: 'Network unavailable' }}
    selected={entries[0].id} onSelect={() => {}} installed={[]} /></I18nProvider>);
  assert.match(html, /Compatibility and permissions/);
  assert.match(html, /settings.read/);
  assert.match(html, /not a grant/);
  assert.match(html, /Build with the local CLI/);
  assert.ok(html.indexOf('settings.read') < html.indexOf('Network unavailable'));
  assert.match(html, /Retry/);
  assert.doesNotMatch(html, /<details/);
});

test('responsive layout is scoped to marketplace content width, with a narrow detail-only fallback', () => {
  const css = readFileSync(new URL('./plugin-marketplace.css', import.meta.url), 'utf8');
  assert.match(css, /\.plugin-marketplace \{ container-type: inline-size;/);
  assert.match(css, /@container \(min-width: 820px\)/);
  assert.match(css, /grid-template-columns: 248px minmax\(0, 1fr\)/);
  assert.match(css, /plugin-marketplace-browser--selected \.plugin-marketplace-catalog \{ display: none;/);
});

test('narrow detail starts at the top and back restores the settings scroll and card focus', async () => {
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => { callback(0); return 0; };
  const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  const pane = { scrollTop: 450 };
  let focused = false;
  const list = { scrollTop: 0, closest: (selector: string) => selector === '.plugin-marketplace' ? { clientWidth: 700 } : pane,
    querySelectorAll: () => [{ dataset: { pluginId: entries[0].id }, focus: () => { focused = true; } }] };
  let renderer!: ReactTestRenderer;
  function Harness() {
    const [selected, setSelected] = useState<string | null>(null);
    return <I18nProvider locale="en"><PluginMarketplaceContent catalog={catalog} selected={selected} onSelect={setSelected} installed={[]} /></I18nProvider>;
  }
  try {
    await act(async () => { renderer = create(<Harness />, { createNodeMock: (element) => element.type === 'div' ? list : { scrollTo() {}, focus() {} } }); });
    const card = renderer.root.findAll((node) => node.type === 'button' && node.props['data-plugin-id'] === entries[0].id)[0];
    await act(async () => card.props.onClick());
    assert.equal(pane.scrollTop, 0);
    const back = renderer.root.findAllByType('button').find((node) => node.children.includes('All plugins'))!;
    await act(async () => back.props.onClick());
    assert.equal(pane.scrollTop, 450);
    assert.equal(focused, true);
    await act(async () => renderer.unmount());
  } finally {
    globalThis.requestAnimationFrame = previousRaf;
    actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test('offline catalog warning keeps details visible and disables market installation', () => {
  const downloadable = { ...entries[0], artifact: { url: 'https://github.com/example/plugin/releases/download/v1/plugin.ncpkg', sha256: 'a'.repeat(64) } };
  const html = renderToStaticMarkup(<I18nProvider locale="en"><PluginMarketplaceContent
    catalog={{ ...catalog, entries: [downloadable], listError: 'Registry offline', source: 'cached' }}
    selected={downloadable.id} onSelect={() => {}} installed={[]} /></I18nProvider>);
  assert.match(html, /Registry offline/);
  assert.match(html, /Installation is unavailable until refresh succeeds/);
  assert.match(html, /Compatibility and permissions/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Install this version/);
  assert.match(html, /Retry/);
});

test('manual refresh remains available after success and is disabled while loading', () => {
  const ready = renderToStaticMarkup(<I18nProvider locale="en"><PluginMarketplaceContent catalog={catalog} selected={null} onSelect={() => {}} installed={[]} /></I18nProvider>);
  assert.match(ready, />Refresh<\/button>/);
  const loading = renderToStaticMarkup(<I18nProvider locale="en"><PluginMarketplaceContent catalog={{ ...catalog, listStatus: 'loading' }} selected={null} onSelect={() => {}} installed={[]} /></I18nProvider>);
  assert.match(loading, /<button[^>]*disabled=""[^>]*>Refresh<\/button>/);
});
