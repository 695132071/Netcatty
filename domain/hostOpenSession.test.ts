import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TerminalSession } from './models';
import { findReusableHostSession } from './hostOpenSession';

function tab(id: string, status: TerminalSession['status'], extra: Partial<TerminalSession> = {}): TerminalSession {
  return { id, hostId: 'host-1', hostLabel: 'Host', hostname: 'example.invalid', username: 'user', status, ...extra };
}

test('host reuse prefers a connected tab over a connecting tab for the same host', () => {
  assert.deepEqual(findReusableHostSession([
    tab('other-host', 'connected', { hostId: 'host-2' }),
    tab('retrying', 'connecting'),
    tab('live', 'connected'),
  ], 'host-1'), { sessionId: 'live', connected: true });
});

test('host reuse keeps the same tab during the reconnect delay and connection attempt', () => {
  assert.deepEqual(findReusableHostSession([tab('retrying', 'connecting')], 'host-1'), {
    sessionId: 'retrying', connected: false,
  });
});

test('host reuse excludes restored placeholders and inactive disconnected tabs', () => {
  assert.equal(findReusableHostSession([
    tab('manual-disconnect', 'disconnected'),
    tab('restored', 'disconnected', { restoreState: 'restored-disconnected' }),
    tab('restoring', 'connecting', { restoreState: 'restored-disconnected' }),
  ], 'host-1'), undefined);
  assert.equal(findReusableHostSession([tab('live', 'connected')], ''), undefined);
});
