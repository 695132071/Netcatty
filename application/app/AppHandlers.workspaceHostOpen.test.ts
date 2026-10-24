import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectionLog, Host } from '../../domain/models';
import { createLocalShellHost } from '../../domain/localShellHost';
import { selectConnectionLogForTerminalDataCapture } from '../../domain/connectionLog';
import { handleConnectToHostImpl, handleTerminalDataCaptureImpl } from './AppHandlers';

test('workspace host launch records resolved metadata and associates replay with its acknowledged session', async () => {
  const host = createLocalShellHost({ id: 'saved-local', label: 'Work shell' });
  const connectionLogs: ConnectionLog[] = [];
  let appendedHost: Host | undefined;
  const getCtx = () => ({
    resolveEffectiveHost: (candidate: Host) => candidate,
    discoveredShells: [{ id: 'zsh', name: 'Z shell', command: '/bin/zsh' }],
    terminalSettings: { localShell: 'zsh', localShellArgs: ['-l'], localStartDir: '/tmp/work' },
    resolveShellSetting: () => ({ command: '/bin/zsh', args: ['-l'] }),
    systemInfoRef: { current: { username: 'local-user', hostname: 'local-machine' } },
    keys: [], identities: [], resolveHostAuth: () => ({ username: 'ignored-ssh-user' }),
    // The App adapts this creation callback to appendHostToWorkspaceConfirmed.
    connectToHost: (candidate: Host) => {
      assert.equal(connectionLogs.length, 0, 'do not record history before insertion is acknowledged');
      appendedHost = candidate;
      return 'workspace-session';
    },
    addConnectionLog: (entry: Omit<ConnectionLog, 'id'>) => {
      connectionLogs.push({ ...entry, id: 'workspace-log' });
    },
  });
  assert.equal(handleConnectToHostImpl(getCtx, host), 'workspace-session');
  assert.equal(appendedHost?.localShell, '/bin/zsh');
  assert.deepEqual(appendedHost?.localShellArgs, ['-l']);
  assert.equal(appendedHost?.localStartDir, '/tmp/work');
  assert.equal(connectionLogs.length, 1);
  assert.equal(connectionLogs[0].sessionId, 'workspace-session');
  assert.equal(connectionLogs[0].hostId, host.id);
  assert.equal(connectionLogs[0].hostLabel, 'Work shell');
  assert.equal(connectionLogs[0].username, 'local-user');
  assert.equal(connectionLogs[0].protocol, 'local');
  assert.equal(connectionLogs[0].localHostname, 'local-machine');
  const updates: Array<{ id: string; terminalData: string }> = [];
  await handleTerminalDataCaptureImpl(() => ({
    IS_DEV: false,
    sessions: [{ id: 'workspace-session', hostname: 'localhost' }],
    // A newer, same-host log must not steal this session's capture.
    connectionLogs: [...connectionLogs, { ...connectionLogs[0], id: 'other-log', sessionId: 'other-session', startTime: Date.now() + 100 }],
    selectConnectionLogForTerminalDataCapture,
    updateConnectionLog: async (id: string, entry: { terminalData: string }) => { updates.push({ id, terminalData: entry.terminalData }); },
  }), 'workspace-session', 'captured terminal output');
  assert.deepEqual(updates, [{ id: 'workspace-log', terminalData: 'captured terminal output' }]);
});

for (const protocol of ['local', 'ssh', 'serial'] as const) {
  test(`refused workspace insertion creates no ${protocol} connection log`, () => {
    let logs = 0;
    const host = { id: 'host', label: 'Host', hostname: 'target', protocol } as Host;
    const sessionId = handleConnectToHostImpl(() => ({
      resolveEffectiveHost: (candidate: Host) => candidate,
      discoveredShells: [], terminalSettings: {}, resolveShellSetting: () => null,
      systemInfoRef: { current: { username: 'local-user', hostname: 'local-machine' } },
      keys: [], identities: [], resolveHostAuth: () => ({ username: 'remote-user' }),
      connectToHost: () => null,
      addConnectionLog: () => { logs += 1; },
    }), host);
    assert.equal(sessionId, null);
    assert.equal(logs, 0);
  });
}
