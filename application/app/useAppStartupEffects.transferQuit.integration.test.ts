/* eslint-disable @typescript-eslint/no-explicit-any -- Electron boundary doubles exercise production modules. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { useAppStartupEffects } from './useAppStartupEffects.ts';
import { sftpTransferCenterStore } from '../state/sftpTransferCenterStore.ts';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge.ts';
const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
const { createMainWindowApi } = require('../../electron/bridges/windowManager/mainWindow.cjs');
const { queryDirtyEditors } = require('../../electron/bridges/dirtyEditorGuard.cjs');
const { createPreloadApi } = require('../../electron/preload/api.cjs');

// No Electron UI, sockets, real transfers, or preferences. Only the network
// pause completion is held. Actual renderer hook, window close callback, and
// dirty-query helper run together with the actual 5000ms production deadline.
for (const slowPause of [true, false]) test(`${slowPause ? 'slow pause refuses close at the production deadline' : 'control: fast pause preserves Cancel'}`, { timeout: 8000 }, async t => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  let confirmations = 0, reports = 0, resumeCalls = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm() { confirmations++; return false; } } });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  let renderer: any, releasePause: any;
  const queryPromises: Promise<void>[] = [];
  const pause = new Promise<void>(resolve => { releasePause = resolve; });
  if (!slowPause) releasePause();
  const ipcMain = new EventEmitter();
  let win: any;
  t.after(async () => {
    releasePause(); await Promise.allSettled(queryPromises);
    await act(async () => renderer?.unmount());
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (oldAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', oldAct); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });
  t.mock.method(sftpTransferCenterStore, 'getSnapshot', () => ({ tasks: [{ id: 'slow-upload', status: 'transferring' }] }) as any);
  t.mock.method(sftpTransferCenterStore, 'pause', () => pause);
  t.mock.method(sftpTransferCenterStore, 'resume', async () => { resumeCalls++; });
  const ipcRenderer = Object.assign(new EventEmitter(), {
    send(channel: string, payload: any) { reports++; ipcMain.emit(channel, { sender: win.webContents }, payload); },
  });
  const preload = createPreloadApi({ ipcRenderer, webUtils: {} });
  t.mock.method(netcattyBridge, 'get', () => ({
    onCheckDirtyEditors(callback: any) {
      return preload.onCheckDirtyEditors((request: any) => { queryPromises.push(callback(request)); });
    },
    reportDirtyEditorsResult: preload.reportDirtyEditorsResult,
  }));
  function Probe() {
    useAppStartupEffects({ enabled: false, updateState: {}, sessions: [], hosts: [], keys: [], identities: [], knownHosts: [], proxyProfiles: [], groupConfigs: [], workspaces: [], portForwardingRules: [], t: (key: string) => key } as any);
    return null;
  }
  await act(async () => { renderer = create(React.createElement(Probe)); });
  class Window extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      id: 71, isDestroyed: () => this.destroyed, isCrashed: () => false,
      setWindowOpenHandler() {}, openDevTools() {},
      send(channel: string, payload: any) { ipcRenderer.emit(channel, {}, payload); },
    });
    close() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; this.emit('close', event); if (!event.prevented) { this.destroyed = true; this.emit('closed'); } }
    isDestroyed() { return this.destroyed; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    getBounds() { return { width: 1000, height: 700 }; }
    setBackgroundColor() {}
    loadURL() { return Promise.resolve(); }
  }
  const api = createMainWindowApi({
    mainWindow: null, electronApp: null, currentTheme: 'light', isQuitting: false,
    pendingWindowStateWrite: null, queuedWindowState: null,
    DEFAULT_WINDOW_WIDTH: 1400, DEFAULT_WINDOW_HEIGHT: 900, MIN_WINDOW_WIDTH: 1100, MIN_WINDOW_HEIGHT: 640,
    V8_CACHE_OPTIONS: 'code', THEME_COLORS: { light: {} },
    unhealthyWebContentsIds: new Set(), rendererReadySeenByWebContentsId: new Set(),
    __dirname: '/unused/electron/bridges', URL, require, console, setTimeout, clearTimeout,
    getGlobalShortcutBridge: () => ({ handleWindowClose: () => false }), getMainWindowCount: () => 1,
    debugLog() {}, resolveFrontendBackgroundColor() { return null; }, loadWindowState() { return null; },
    getDevRendererBaseUrl: (url: string) => url, getWindowBoundsState() { return null; },
    queueWindowStateSave() {}, saveWindowStateSync() {}, setupDeferredShow() {},
    createExternalOnlyWindowOpenHandler() { return {}; }, createAppWindowOpenHandler() { return {}; },
    attachOAuthLoadingOverlay() {}, registerWindowHandlers() {}, requestWindowCommandClose() {}, shouldCloseWindowFromInput() { return false; },
    registerMainWindow() {}, unregisterMainWindow() {}, registerAppContentWindow() {}, unregisterAppContentWindow() {},
    notifyAppContentWindowClosed() {}, applyWindowOpacityToWindow() {}, closeSettingsWindow() {}, hideSettingsWindow() {},
    hasEditorTabsForSource: () => false, closeEditorTabsForSource: async () => ({ success: true }),
    queryDirtyEditors(wc: any, timeout: number, options: any) {
      assert.equal(timeout, 5000, 'real close callback supplies the 5-second timeout');
      return queryDirtyEditors(wc, timeout, options);
    },
  });
  win = await api.createWindow({ BrowserWindow: Window, nativeTheme: {}, app: {}, screen: {}, shell: {}, ipcMain }, {
    preload: '/tmp/unused-preload.cjs', devServerUrl: 'http://localhost:5173', isDev: true, isMac: false,
    electronDir: '/unused/electron', registerAsMainWindow: true,
  });
  win.close();
  assert.equal(win.destroyed, false, 'first close is correctly guarded');
  await new Promise(resolve => setTimeout(resolve, slowPause ? 5250 : 50));
  if (!slowPause) {
    assert.equal(confirmations, 1); assert.equal(reports, 2); assert.equal(resumeCalls, 1);
    assert.equal(win.destroyed, false, 'Cancel keeps owner alive when pause settles before deadline');
    console.log('QUIT_FAST_CONTROL', JSON.stringify({ ownerAlive: true, confirmations, reports, resumeCalls }));
    return;
  }
  assert.equal(confirmations, 0, 'slow pause prevents prompt');
  assert.equal(win.destroyed, false, 'deadline refuses close while the pause is pending');
  assert.equal(reports, 1, 'only the pending-transfer acknowledgement has been sent');
  assert.equal(ipcMain.listenerCount('app:dirty-editors-result'), 0, 'main query is settled, not hung');
  releasePause(); await Promise.allSettled(queryPromises);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(confirmations, 0, 'the expired request must not show a late prompt');
  assert.equal(win.destroyed, false);
  assert.equal(resumeCalls, 1);
  console.log('QUIT_TIMEOUT_REGRESSION', JSON.stringify({ ownerAlive: true, productionDeadlineMs: 5000, scaling: false, resumeCalls }));
});
