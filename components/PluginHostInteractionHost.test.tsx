import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';

test('host dialog drives choice/input/copy and the two-phase clipboard share using real service action tokens', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../application/i18n/I18nProvider');
  const { PluginHostInteractionHost } = await import('./plugins/PluginHostInteractionHost');
  const { PluginHostInteractionService, assertInteractionRequest } = await import('../electron/plugins/hostInteractionService.cjs');
  let listener: ((event: unknown) => void) | null = null;
  let reads = 0;
  const writes: string[] = [];
  const audits: unknown[] = [];
  const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false, send(_channel: string, payload: unknown) { listener?.(payload); } });
  const owner = Object.assign(new EventEmitter(), { webContents: sender, isFocused: () => true, isVisible: () => true, isDestroyed: () => false });
  const service = new PluginHostInteractionService({
    getWindow: () => owner, isLocked: () => false,
    permissionEngine: { onDidRevoke() { return { dispose() {} }; } },
    database: { recordSecurityAudit(...args: unknown[]) { audits.push(args); } },
    quotaManager: { chargeBytes() {} },
    clipboard: { readText() { reads++; return 'synthetic private text'; }, writeText(value: string) { writes.push(value); } },
  });
  Object.assign(dom.window, { netcatty: {
    onPluginInteraction(callback: (event: unknown) => void) { listener = callback; return () => { listener = null; }; },
    async setPluginInteractionReady(ready: boolean) { return service.setReady(sender, ready); },
    async respondPluginInteraction(response: unknown) { return service.respond(sender, response); },
  } });
  const context = { pluginId: 'com.example.synthetic', pluginVersion: '1.0.0', runtimeId: 'runtime-synthetic', signal: new AbortController().signal, async assertActive() {} };
  const root = createRoot(document.getElementById('root')!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent === text)!;
  const click = async (element: HTMLElement) => { assert.ok(element); await act(async () => { element.click(); await settle(); }); };
  const begin = async (params: unknown) => {
    let promise!: Promise<unknown>;
    await act(async () => { promise = service.request(assertInteractionRequest(params), context); void promise.catch(() => {}); await settle(); });
    return { promise };
  };
  try {
    await act(async () => root.render(<I18nProvider locale="en"><PluginHostInteractionHost /></I18nProvider>));
    const choice = await begin({ kind: 'quickPick', title: 'Synthetic choice', items: [{ id: 'compose', label: 'Compose' }] });
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /com.example.synthetic/);
    assert.equal(button('Continue').disabled, true);
    await click(document.querySelector<HTMLInputElement>('input[type="radio"]')!);
    await click(button('Continue'));
    assert.deepEqual(await choice.promise, { cancelled: false, value: 'compose' });
    const input = await begin({ kind: 'input', title: 'Synthetic input', initialValue: 'synthetic output' });
    assert.equal(document.querySelector<HTMLInputElement>('input')?.value, 'synthetic output');
    await click(button('Continue'));
    assert.deepEqual(await input.promise, { cancelled: false, value: 'synthetic output' });
    const copy = await begin({ kind: 'clipboard.write', title: 'Copy result', text: 'synthetic output' });
    assert.deepEqual(writes, []);
    assert.equal(document.querySelector('textarea')?.value, 'synthetic output');
    await click(button('Copy to clipboard'));
    assert.deepEqual(await copy.promise, { cancelled: false, value: true });
    assert.deepEqual(writes, ['synthetic output']);
    const share = await begin({ kind: 'clipboard.read', title: 'Share clipboard' });
    assert.equal(reads, 0);
    assert.equal(document.querySelector('textarea'), null);
    await click(button('Preview clipboard'));
    assert.equal(reads, 1);
    assert.equal(document.querySelector('textarea')?.value, 'synthetic private text');
    await click(button('Share with plugin'));
    assert.deepEqual(await share.promise, { cancelled: false, value: 'synthetic private text' });
    assert.equal(JSON.stringify(audits).includes('synthetic private text'), false);
    const cancelled = await begin({ kind: 'clipboard.write', title: 'Cancelled copy', text: 'must not copy' });
    await click(button('Cancel'));
    assert.deepEqual(await cancelled.promise, { cancelled: true });
    assert.deepEqual(writes, ['synthetic output']);
    assert.equal(service.pending.size, 0);
  } finally {
    await act(async () => { root.unmount(); }); service.shutdown(); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
