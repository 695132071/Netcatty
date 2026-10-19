import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { useServerStats } from './useServerStats';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

for (const scenario of ['retry', 'pause', 'manual'] as const) {
  test(`server stats ${scenario} after three failures`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10_000 });
    const originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
    let calls = 0;
    t.mock.method(netcattyBridge, 'get', () => ({
      getServerStats: async () => {
        calls++;
        return calls <= 3 ? { success: false, error: 'temporary failure' }
          : { success: true, stats: { cpu: 42 } };
      },
    }));
    let current: ReturnType<typeof useServerStats>;
    function Probe({ enabled = true }: { enabled?: boolean }) {
      current = useServerStats({ sessionId: `recovery-${scenario}`, enabled,
        refreshInterval: 5, isSupportedOs: true, isConnected: true });
      return null;
    }
    let root: ReactTestRenderer;
    try {
      await act(async () => { root = create(React.createElement(Probe)); });
      await act(async () => t.mock.timers.tick(2000));
      await act(async () => t.mock.timers.tick(3000));
      await act(async () => t.mock.timers.tick(5000));
      assert.equal(calls, 3);
      assert.equal(current!.error, 'temporary failure');
      if (scenario === 'pause') {
        await act(async () => root!.update(React.createElement(Probe, { enabled: false })));
        await act(async () => t.mock.timers.tick(60_000));
        assert.equal(calls, 3, 'disabled clients must not retry');
        await act(async () => root!.update(React.createElement(Probe)));
        await act(async () => t.mock.timers.tick(1));
      } else if (scenario === 'manual') {
        await act(async () => current!.refresh());
      } else {
        await act(async () => t.mock.timers.tick(29_999));
        assert.equal(calls, 3);
        await act(async () => t.mock.timers.tick(1));
        await act(async () => t.mock.timers.tick(1));
      }
      assert.equal(calls, 4);
      assert.equal(current!.stats.cpu, 42);
      assert.equal(current!.error, null);
      await act(async () => t.mock.timers.tick(5000));
      assert.equal(calls, 5, 'successful recovery must resume normal polling');
    } finally {
      await act(async () => root?.unmount());
      if (originalActEnvironment) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      t.mock.timers.reset();
    }
  });
}

test('stats reply after disabling cannot publish or schedule recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10_000 });
  const originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  let finish: (result: unknown) => void;
  let calls = 0;
  t.mock.method(netcattyBridge, 'get', () => ({ getServerStats: () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  } }));
  let current: ReturnType<typeof useServerStats>;
  function Probe({ enabled }: { enabled: boolean }) {
    current = useServerStats({ sessionId: 'late-disabled', enabled,
      refreshInterval: 5, isSupportedOs: true, isConnected: true });
    return null;
  }
  let root: ReactTestRenderer;
  try {
    await act(async () => { root = create(React.createElement(Probe, { enabled: true })); });
    await act(async () => t.mock.timers.tick(2000));
    assert.equal(calls, 1);
    await act(async () => root!.update(React.createElement(Probe, { enabled: false })));
    await act(async () => finish!({ success: true, stats: { cpu: 99 } }));
    assert.equal(current!.stats.lastUpdated, null);
    assert.equal(current!.isLoading, false);
    await act(async () => t.mock.timers.tick(60_000));
    assert.equal(calls, 1);
  } finally {
    await act(async () => root?.unmount());
    if (originalActEnvironment) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    t.mock.timers.reset();
  }
});
