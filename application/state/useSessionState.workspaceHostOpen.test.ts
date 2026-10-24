import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createLocalShellHost, resolveHostDefaultLocalShell } from '../../domain/localShellHost';
import { collectSessionIds } from '../../domain/workspace';
import { activeTabStore } from './activeTabStore';
import { useSessionState } from './useSessionState';

test('workspace host opening acknowledges committed insertion and rejects queued closure', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    activeTabStore.setActiveTabId('vault');
  });
  let state: ReturnType<typeof useSessionState>;
  function Probe() {
    state = useSessionState({ persistSessionRestore: false });
    return null;
  }
  await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Probe))));
  const host = createLocalShellHost({ id: 'local-inheriting' });
  await act(async () => state.createWorkspaceWithHosts('Target', [host]));
  const workspaceId = state!.workspaces[0].id;
  const resolvedHost = resolveHostDefaultLocalShell(host, {
    terminalSettings: { localShell: '/bin/zsh', localShellArgs: ['-l'], localStartDir: '/tmp/project' },
  });
  let ordinaryId: string | null = null;
  await act(async () => {
    ordinaryId = state.appendHostToWorkspace(workspaceId, resolvedHost);
  });
  assert.ok(ordinaryId);
  assert.ok(state!.sessions.some(session => session.id === ordinaryId));
  assert.ok(collectSessionIds(state!.workspaces[0].root).includes(ordinaryId));
  let insertedId: string | null = null;
  await act(async () => {
    insertedId = state.appendHostToWorkspaceConfirmed(workspaceId, resolvedHost);
    assert.ok(insertedId, 'success is returned after both state updates commit');
    const session = state.sessions.find(s => s.id === insertedId);
    assert.equal(session?.localShell, '/bin/zsh');
    assert.deepEqual(session?.localShellArgs, ['-l']);
    assert.equal(session?.localStartDir, '/tmp/project');
    assert.equal(state.sessions.filter(s => s.id === insertedId).length, 1);
    assert.equal(collectSessionIds(state.workspaces[0].root).filter(id => id === insertedId).length, 1);
  });
  await act(async () => {
    // The rendered ref still contains the workspace; its close updater is queued.
    state.closeWorkspace(workspaceId);
    const result = state.appendHostToWorkspaceConfirmed(workspaceId, resolvedHost);
    assert.equal(result, null, 'must not acknowledge an allocated but uninserted ID');
  });
  assert.equal(state!.workspaces.length, 0);
  assert.equal(state!.sessions.length, 0, 'no orphan session survives the queued close');
  assert.equal(activeTabStore.getActiveTabId(), 'vault');
  await act(async () => {
    assert.equal(state.appendHostToWorkspaceConfirmed(workspaceId, resolvedHost), null);
  });
});

test('agent workspace host opening uses the common launch and history handler', () => {
  const source = readFileSync(new URL('../app/AppSideEffects.tsx', import.meta.url), 'utf8');
  assert.match(source, /const sessionId = handleConnectToHost\(host, true, hidden, target\.workspaceId\)/);
  assert.match(source, /connectToHost: workspaceId\s*\? \(candidate: Host\) => appendHostToWorkspaceConfirmed\(workspaceId, candidate\)\s*: connectToHost/);
});
