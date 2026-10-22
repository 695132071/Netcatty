import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { performSessionLogAction } from './sessionLogActions';
import { STORAGE_KEY_SESSION_LOG_APPLICATION } from '../../infrastructure/config/storageKeys';

test('session log actions resolve and flush the selected session, remember apps and reset to default', async () => {
  const dom = new JSDOM('', { url: 'http://localhost' });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage });
  const calls: unknown[][] = [];
  let picked: { path: string; name: string } | null = { path: '/Applications/My Editor.app', name: 'My Editor' };
  let available = true;
  let failOpen = false;
  const bridge = {
    prepareSessionLog: async (payload: { sessionId: string }) => {
      calls.push(['prepare', payload]);
      return available ? { success: true, filePath: `/logs/${payload.sessionId}.html` }
        : { success: false, error: 'No saved log for this session' };
    },
    revealSessionLog: async (payload: { sessionId: string }) => {
      calls.push(['reveal', payload]);
      return { success: true };
    },
    selectApplication: async () => { calls.push(['choose']); return picked; },
    openWithApplication: async (file: string, app: string) => {
      calls.push(['application', file, app]);
      if (failOpen) throw new Error('Launch failed');
      return true;
    },
    openWithSystemDefault: async (file: string) => { calls.push(['default', file]); return { success: true }; },
  };
  Object.assign(dom.window, { netcatty: bridge });
  try {
    await performSessionLogAction('first', 'open');
    assert.deepEqual(calls.splice(0), [['prepare', { sessionId: 'first' }], ['default', '/logs/first.html']]);
    await performSessionLogAction('second', 'chooseApplication');
    assert.deepEqual(calls.splice(0), [
      ['prepare', { sessionId: 'second' }], ['choose'], ['prepare', { sessionId: 'second' }],
      ['application', '/logs/second.html', picked!.path],
    ]);
    assert.equal(JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY_SESSION_LOG_APPLICATION)!).name, 'My Editor');
    await performSessionLogAction('first', 'open');
    assert.deepEqual(calls.splice(0), [['prepare', { sessionId: 'first' }], ['application', '/logs/first.html', picked!.path]]);
    await performSessionLogAction('first', 'reveal');
    assert.deepEqual(calls.splice(0), [['reveal', { sessionId: 'first' }]]);
    await performSessionLogAction('first', 'systemDefault');
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_SESSION_LOG_APPLICATION), null);
    calls.length = 0;
    picked = null;
    await performSessionLogAction('first', 'chooseApplication');
    assert.deepEqual(calls.splice(0), [['prepare', { sessionId: 'first' }], ['choose']]);
    available = false;
    await assert.rejects(performSessionLogAction('missing', 'chooseApplication'), /No saved log/);
    assert.deepEqual(calls.splice(0), [['prepare', { sessionId: 'missing' }]]);
    available = true;
    picked = { path: '/missing-editor', name: 'Missing' };
    failOpen = true;
    await assert.rejects(performSessionLogAction('first', 'chooseApplication'), /Launch failed/);
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_SESSION_LOG_APPLICATION), null);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    dom.window.close();
  }
});

// The integration boundary must translate backend errors, including ordinary
// Error instances. Raw filesystem/app-launch details belong only in diagnostics.
test('terminal log action errors use the translated toast instead of raw backend text', () => {
  const source = readFileSync(new URL('../../components/Terminal.tsx', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('  const handleSessionLogAction ='),
    source.indexOf('  const handleToggleSessionLog ='));
  assert.match(handler, /logger\.error\("\[Terminal\] Failed to open or reveal session log:", err\)/);
  assert.match(handler, /toast\.error\(t\('terminal\.toolbar\.openSessionLogFailed'\)\)/);
  assert.doesNotMatch(handler, /err\.message/);
});
