import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

test('default host adapter, real preload, mounted host chooser and installed assistant reach only the local fixture', { timeout: 20_000 }, async () => {
  // JSDOM + the in-process runtime prove app wiring; they are not native sandbox
  // evidence. All state is synthetic, with no real provider, key, Note or host.
  const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netcatty-ai-ui-'));
  const oldTmp = process.env.TMPDIR; process.env.TMPDIR = fixtureRoot;
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'DocumentFragment']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('localStorage', dom.window.localStorage);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PluginAIContextHost } = await import('./plugins/PluginAIContextHost');
  const { I18nProvider } = await import('../application/i18n/I18nProvider');
  const { publishNotesSnapshot, getNotesSnapshot } = await import('../application/state/notesStore');
  const { registerAppAppLockRuntime, getAppAppLockRuntime } = await import('../application/state/appRuntimeBridge');
  const { STORAGE_KEY_AI_PROVIDERS, STORAGE_KEY_AI_ACTIVE_PROVIDER, STORAGE_KEY_AI_ACTIVE_MODEL } = await import('../infrastructure/config/storageKeys');
  const { createAssistantProviderFixture } = await import('../scripts/plugin-assistant-provider-fixture.mjs');
  const { createPluginHostService } = require('../electron/plugins/hostService.cjs');
  const { inProcessBrowserRuntime } = require('../electron/plugins/fixtures/inProcessBrowserRuntime.cjs');
  const { createPreloadApi } = require('../electron/preload/api.cjs');
  const aiBridge = require('../electron/bridges/aiBridge.cjs');
  const { server, counts } = createAssistantProviderFixture({ delayMs: 25 });
  const oldNotes = getNotesSnapshot(); const oldLock = getAppAppLockRuntime();
  let service: ReturnType<typeof createPluginHostService> | undefined;
  let panel: JSDOM | undefined;
  const root = createRoot(document.getElementById('root')!);
  let locked = false; let contentAllowed = false; let reviewAllowed = false;
  const lockListeners = new Set<(state: { locked: boolean }) => void>();
  const reviews: Array<Record<string, unknown>> = [];
  const trustedPayloads: unknown[] = [];
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcRenderer = new EventEmitter() as EventEmitter & { invoke: (channel: string, payload: unknown) => Promise<unknown> };
    const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: (channel: string, payload: unknown) => {
      if (channel === 'netcatty:plugins:ai-host-request') trustedPayloads.push(structuredClone(payload));
      ipcRenderer.emit(channel, {}, structuredClone(payload));
    } });
    const mainWindow = Object.assign(new EventEmitter(), { webContents: sender, isDestroyed: () => false, isVisible: () => true, isFocused: () => true });
    ipcRenderer.invoke = async (channel, payload) => {
      if (channel === 'netcatty:ai:chat:stream') {
        const request = payload as { url: string; headers: Record<string, string>; body: string; requestId: string };
        assert.equal(new URL(request.url).origin, new URL(endpoint).origin);
        assert.doesNotMatch(JSON.stringify(request), /fixture-only/);
        const status = await aiBridge._streamRequestForTests(request.url, { headers: request.headers, body: request.body }, { sender }, request.requestId, false);
        return { ok: status.statusCode === 200, ...status };
      }
      if (channel === 'netcatty:ai:chat:cancel') return aiBridge.cancelPluginAIStreamsForSender(sender) > 0;
      const handler = ipcHandlers.get(channel);
      assert.ok(handler, `Unexpected trusted IPC: ${channel}`);
      return handler({ sender }, structuredClone(payload));
    };
    const api = createPreloadApi({ ipcRenderer, webUtils: {} });
    Object.defineProperty(dom.window, 'netcatty', { value: api });
    const syntheticNote = { id: 'synthetic-note', title: 'Synthetic retry plan', content: 'Synthetic retry plan: add a retry button.', createdAt: 1, updatedAt: 1 };
    publishNotesSnapshot({ notes: [syntheticNote], noteGroups: [] });
    registerAppAppLockRuntime({ locked: false } as NonNullable<ReturnType<typeof getAppAppLockRuntime>>);
    dom.window.localStorage.setItem(STORAGE_KEY_AI_PROVIDERS, JSON.stringify([{ id: 'qa-provider', name: 'QA fixture', providerId: 'custom', enabled: true, baseURL: endpoint, defaultModel: 'deterministic-fixture', apiKey: 'fixture-only' }]));
    dom.window.localStorage.setItem(STORAGE_KEY_AI_ACTIVE_PROVIDER, 'qa-provider');
    dom.window.localStorage.setItem(STORAGE_KEY_AI_ACTIVE_MODEL, 'deterministic-fixture');
    service = createPluginHostService({
      app: { getAppPath: () => rootPath, getPath: () => fixtureRoot, getVersion: () => '0.0.0' }, env: {},
      getInteractionWindow: () => mainWindow, isAppLocked: () => locked,
      subscribeAppLock: (listener: (state: { locked: boolean }) => void) => { lockListeners.add(listener); return () => lockListeners.delete(listener); },
      electron: { ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => ipcHandlers.set(name, handler), removeHandler: (name: string) => ipcHandlers.delete(name) },
        dialog: { showMessageBox: async (_window: unknown, options: Record<string, unknown>) => { reviews.push(options); return { response: reviewAllowed ? 0 : 1 }; } } },
      requestPermissionDecision: async (request: { requestId: string; permission: string }) => request.permission === 'context.selected.read' && !contentAllowed
        ? { requestId: request.requestId, decision: 'deny' }
        : { requestId: request.requestId, decision: 'allow', scope: request.permission === 'context.selected.read' ? 'once' : 'application' },
    });
    service.runtimeSupervisor.runtimeFactories.browser = inProcessBrowserRuntime;
    await service.manager.initialize();
    const staging = path.join(fixtureRoot, 'package'); fs.mkdirSync(path.join(staging, 'dist'), { recursive: true });
    const sample = path.join(rootPath, 'examples/plugins/assistant');
    for (const file of ['netcatty.plugin.json', 'panel.html', 'panel.css', 'panel.js', 'README.md']) fs.copyFileSync(path.join(sample, file), path.join(staging, file));
    fs.copyFileSync(path.join(sample, 'src/index.js'), path.join(staging, 'dist/index.js'));
    const { buildPluginPackage } = await import('@netcatty/plugin-cli');
    const archive = path.join(fixtureRoot, 'assistant.ncpkg'); await buildPluginPackage(staging, archive);
    await service.manager.install(archive, { enable: true });
    await act(async () => root.render(<I18nProvider locale="en"><PluginAIContextHost sessions={[]} workspaces={[]} /></I18nProvider>));
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!condition()) {
        if (Date.now() >= deadline) throw Error('Connected host UI state timed out');
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
      }
    };
    panel = new JSDOM(fs.readFileSync(path.join(sample, 'panel.html'), 'utf8'), { runScripts: 'outside-only' });
    Object.defineProperty(panel.window, 'netcattyView', { value: {
      executeCommand: async (command: string, args: unknown) => structuredClone(await service!.contributionService.executeCommand(command, structuredClone(args))),
      onDidReceiveMessage: () => ({ dispose() {} }),
    } });
    await act(async () => panel!.window.eval(fs.readFileSync(path.join(sample, 'panel.js'), 'utf8')));
    await waitFor(() => document.getElementById('plugin-ai-note') !== null);
    const noteChoice = document.getElementById('plugin-ai-note') as HTMLSelectElement;
    assert.equal(noteChoice.options.length, 2);
    await act(async () => { noteChoice.value = syntheticNote.id; noteChoice.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Share selected summaries')!.click(); });
    const element = (id: string) => panel!.window.document.getElementById(id)!;
    await waitFor(() => element('status').textContent === 'Ready');
    assert.match(element('model').textContent!, /QA fixture/);
    const reference = element('context') as HTMLSelectElement;
    assert.equal(reference.value, ''); assert.equal(reference.options.length, 2);
    assert.notEqual(reference.options[1].value, syntheticNote.id); reference.value = reference.options[1].value;
    const send = () => element('compose').dispatchEvent(new panel!.window.Event('submit', { cancelable: true }));
    send(); await waitFor(() => element('status').textContent!.startsWith('Request ended'));
    assert.equal(counts.requests, 0); assert.equal(reviews.length, 0);
    contentAllowed = true;
    send(); await waitFor(() => element('status').textContent!.startsWith('Request ended'));
    assert.equal(counts.requests, 0); assert.equal(reviews.length, 1);
    assert.equal(reviews[0].defaultId, reviews[0].cancelId); assert.match(String(reviews[0].detail), /Synthetic retry plan: add a retry button/);
    reviewAllowed = true;
    send(); await waitFor(() => element('status').textContent === 'Complete');
    assert.equal(counts.completed, 1); assert.match(element('response').textContent!, /Synthetic plan/); assert.match(element('usage').textContent!, /12 input tokens/);
    send(); await waitFor(() => element('response').textContent!.startsWith('Synthetic plan: '));
    element('stop').dispatchEvent(new panel.window.Event('click'));
    await waitFor(() => element('status').textContent === 'Stopped' && counts.aborted === 1);
    const stoppedText = element('response').textContent; await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(element('response').textContent, stoppedText);
    send(); await waitFor(() => element('response').textContent!.startsWith('Synthetic plan: '));
    locked = true; registerAppAppLockRuntime({ locked: true } as NonNullable<ReturnType<typeof getAppAppLockRuntime>>);
    for (const listener of lockListeners) listener({ locked: true });
    await waitFor(() => counts.aborted === 2 && service!.aiContextService.broker.turns.size === 0);
    assert.equal(aiBridge._getActiveStreamCountForTests(), 0);
    assert.doesNotMatch(JSON.stringify(trustedPayloads), /fixture-only|apiKey|privateOwner|permissionMode|mcp/);
  } finally {
    panel?.window.close();
    await act(async () => root.unmount());
    await service?.manager.shutdown(); aiBridge.cleanup();
    publishNotesSnapshot(oldNotes); registerAppAppLockRuntime(oldLock);
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    dom.window.close();
    for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
