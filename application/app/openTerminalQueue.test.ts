import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenTerminalQueue } from './openTerminalQueue';

test('idle open-terminal work stays in call order on the caller turn', () => {
  const queue = createOpenTerminalQueue();
  const order: string[] = [];

  queue.enqueue(() => { order.push('path-a'); });
  queue.enqueue(() => { order.push('path-b'); });

  assert.deepEqual(order, ['path-a', 'path-b']);
});

test('a path-only open waits for an in-flight shell discovery', async () => {
  const queue = createOpenTerminalQueue();
  const order: string[] = [];
  let releaseDiscovery: () => void = () => {};
  const discovery = new Promise<void>((resolve) => {
    releaseDiscovery = resolve;
  });

  const shellRequest = queue.enqueue(async () => {
    order.push('shell');
    await discovery;
    order.push('shell-tab');
  });
  const pathRequest = queue.enqueue(() => {
    order.push('path-tab');
  });

  assert.deepEqual(order, ['shell']);
  releaseDiscovery();
  await shellRequest;
  await pathRequest;
  assert.deepEqual(order, ['shell', 'shell-tab', 'path-tab']);
});

test('a failed open-terminal request does not block the next one', async () => {
  const queue = createOpenTerminalQueue();
  const order: string[] = [];

  const failed = queue.enqueue(async () => {
    order.push('shell');
    throw new Error('discovery failed');
  });
  const next = queue.enqueue(() => {
    order.push('path-tab');
  });

  await assert.rejects(failed, /discovery failed/);
  await next;
  assert.deepEqual(order, ['shell', 'path-tab']);
});
