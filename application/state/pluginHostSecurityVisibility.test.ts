import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { observePluginHostSecurityVisibility } from './pluginHostSecurityVisibility';

test('native modal yields to the host chooser, restores on dismissal, and never restores after cleanup', async () => {
  const dom = new JSDOM('<body><div role="dialog" aria-modal="true"><div id="mount"></div></div></body>');
  try {
    const { document } = dom.window;
    const calls: boolean[] = [];
    const stop = observePluginHostSecurityVisibility(document.getElementById('mount')!, (visible) => calls.push(visible));
    const flush = () => new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
    assert.deepEqual(calls, []); // Its own modal does not hide the plugin.
    const chooser = document.createElement('div');
    chooser.dataset.hostSecuritySurface = '';
    document.body.append(chooser);
    await flush(); assert.deepEqual(calls, [false]);
    chooser.remove(); await flush(); assert.deepEqual(calls, [false, true]);
    document.body.append(chooser); await flush();
    assert.deepEqual(calls, [false, true, false]);
    stop(); chooser.remove(); await flush();
    assert.deepEqual(calls, [false, true, false]);
  } finally { dom.window.close(); }
});

test('hidden security surfaces do not occlude a native view', async () => {
  const dom = new JSDOM('<body><div id="mount"></div><div hidden><div data-host-security-surface></div></div></body>');
  try {
    const calls: boolean[] = [];
    const stop = observePluginHostSecurityVisibility(dom.window.document.getElementById('mount')!, (visible) => calls.push(visible));
    assert.deepEqual(calls, []);
    dom.window.document.querySelector('[hidden]')!.removeAttribute('hidden');
    await new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
    assert.deepEqual(calls, [false]); stop();
  } finally { dom.window.close(); }
});
