import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../application/i18n/I18nProvider';
import type { Host } from '../domain/models';
import { SerialHostDetailsPanel } from './SerialHostDetailsPanel';

function renderPanel(path: string, hostname = path) {
  const host: Host = {
    id: 'serial-test', label: 'VM console', hostname, protocol: 'serial',
    port: 115200, username: '', tags: [], os: 'linux',
    serialConfig: { path, baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' },
  };
  return renderToStaticMarkup(<I18nProvider locale="en"><SerialHostDetailsPanel
    initialData={host} onSave={() => {}} onCancel={() => {}}
  /></I18nProvider>);
}

test('saved named-pipe host is editable without hardware baud controls', () => {
  const html = renderPanel(String.raw`\\.\pipe\vm-console`);
  assert.match(html, /VM must create the pipe as a server/);
  assert.doesNotMatch(html, /for="baud-rate"/);
  assert.doesNotMatch(html, /text-destructive/);
});

test('hardware serial host retains its baud-rate controls', () => {
  assert.match(renderPanel('COM3'), /for="baud-rate"/);
});

test('editor prefers the stored pipe path over a stale hardware hostname', () => {
  const html = renderPanel(String.raw`\\.\pipe\VM console`, 'COM3');
  assert.doesNotMatch(html, /for="baud-rate"/);
});
