import assert from 'node:assert/strict';
import test from 'node:test';
import { HOST_BROWSER_MIN_LIVE_EXTENT, resolveHostBrowserPaneBesidePanels } from './hostBrowser';

const pane = { x: 200, y: 100, width: 500, height: 600 };

test('panels beside the pane leave it unchanged, even when the pane itself is small', () => {
  assert.equal(resolveHostBrowserPaneBesidePanels(pane, [{ x: 700, y: 0, width: 300, height: 900 }]), pane);
  const small = { x: 0, y: 0, width: HOST_BROWSER_MIN_LIVE_EXTENT - 1, height: 80 };
  assert.equal(resolveHostBrowserPaneBesidePanels(small, []), small);
});

test('full-height or full-width edge panels shrink the pane to the remaining rectangle', () => {
  assert.deepEqual(resolveHostBrowserPaneBesidePanels(pane, [{ x: 450, y: 0, width: 600, height: 900 }]),
    { x: 200, y: 100, width: 250, height: 600 });
  assert.deepEqual(resolveHostBrowserPaneBesidePanels(pane, [{ x: 0, y: 0, width: 300, height: 900 }]),
    { x: 300, y: 100, width: 400, height: 600 });
  assert.deepEqual(resolveHostBrowserPaneBesidePanels(pane, [{ x: 0, y: 500, width: 900, height: 400 }]),
    { x: 200, y: 100, width: 500, height: 400 });
  assert.deepEqual(resolveHostBrowserPaneBesidePanels(pane, [
    { x: 0, y: 0, width: 300, height: 900 },
    { x: 550, y: 0, width: 400, height: 900 },
  ]), { x: 300, y: 100, width: 250, height: 600 });
});

test('panels over the middle, a corner, or leaving too little room cannot keep a live page', () => {
  assert.equal(resolveHostBrowserPaneBesidePanels(pane, [{ x: 300, y: 0, width: 100, height: 900 }]), null);
  assert.equal(resolveHostBrowserPaneBesidePanels(pane, [{ x: 600, y: 0, width: 300, height: 300 }]), null);
  assert.equal(resolveHostBrowserPaneBesidePanels(pane, [{ x: 0, y: 0, width: 900, height: 900 }]), null);
  assert.equal(resolveHostBrowserPaneBesidePanels(pane, [{ x: 250, y: 0, width: 600, height: 900 }]), null);
});
