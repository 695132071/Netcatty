import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VAULT_HOST_DRAG_ID,
  VAULT_HOST_DRAG_IDS,
  applyVaultHostDragData,
  dispatchVaultHostGroupMove,
  isVaultHostDraggable,
  readVaultDraggedHostIds,
  resolveVaultHostDragIds,
} from './vaultHostDrag.ts';

test('outside multi-select a host drag carries only that host', () => {
  const ids = resolveVaultHostDragIds({
    hostId: 'a',
    isMultiSelectMode: false,
    selectedHostIds: new Set(['a', 'b']),
  });
  assert.deepEqual(ids, ['a']);
  assert.equal(isVaultHostDraggable(false, new Set(), 'a'), true);

  const written: Record<string, string> = {};
  applyVaultHostDragData({
    effectAllowed: '',
    setData: (type, value) => {
      written[type] = value;
    },
  }, ids!);
  assert.deepEqual(written, { [VAULT_HOST_DRAG_ID]: 'a' });
});

test('a multi-select drag starts only on an already selected host and carries every selected id', () => {
  assert.equal(resolveVaultHostDragIds({
    hostId: 'c',
    isMultiSelectMode: true,
    selectedHostIds: new Set(['a', 'b']),
  }), null);
  assert.equal(isVaultHostDraggable(true, new Set(['a', 'b']), 'c'), false);

  const ids = resolveVaultHostDragIds({
    hostId: 'b',
    isMultiSelectMode: true,
    selectedHostIds: new Set(['a', 'b', 'c']),
  });
  assert.deepEqual(ids, ['b', 'a', 'c']);

  const written: Record<string, string> = {};
  applyVaultHostDragData({
    effectAllowed: 'none',
    setData: (type, value) => {
      written[type] = value;
    },
  }, ids!);
  assert.equal(written[VAULT_HOST_DRAG_ID], 'b');
  assert.deepEqual(JSON.parse(written[VAULT_HOST_DRAG_IDS]), ['b', 'a', 'c']);
});

test('reading a drag payload prefers the multi-id list and falls back to one host id', () => {
  assert.deepEqual(readVaultDraggedHostIds((type) => (
    type === VAULT_HOST_DRAG_IDS ? JSON.stringify(['a', 'b', 'a']) : 'a'
  )), ['a', 'b', 'a']);
  assert.deepEqual(readVaultDraggedHostIds((type) => (
    type === VAULT_HOST_DRAG_ID ? 'solo' : ''
  )), ['solo']);
  assert.deepEqual(readVaultDraggedHostIds((type) => (
    type === VAULT_HOST_DRAG_IDS ? '{nope' : 'solo'
  )), ['solo']);
  assert.deepEqual(readVaultDraggedHostIds(() => ''), []);
});

test('multi-id drag payload plans one batched group move', () => {
  const singleCalls: string[] = [];
  const batchCalls: Array<{ ids: string[]; group: string | null }> = [];
  const moved = dispatchVaultHostGroupMove({
    hostIds: readVaultDraggedHostIds((type) => (
      type === VAULT_HOST_DRAG_IDS ? JSON.stringify(['a', 'b', 'c']) : 'a'
    )),
    groupPath: 'Ops/Nested',
    moveHostToGroup: (hostId, groupPath) => {
      singleCalls.push(`${hostId}:${String(groupPath)}`);
    },
    moveHostsToGroup: (hostIds, groupPath) => {
      batchCalls.push({ ids: [...hostIds], group: groupPath });
    },
  });

  assert.equal(moved, true);
  assert.deepEqual(singleCalls, []);
  assert.deepEqual(batchCalls, [{ ids: ['a', 'b', 'c'], group: 'Ops/Nested' }]);
});

test('a single host id still moves through the single-host path when no batch handler is present', () => {
  const calls: string[] = [];
  const moved = dispatchVaultHostGroupMove({
    hostIds: ['host-1'],
    groupPath: null,
    moveHostToGroup: (hostId, groupPath) => {
      calls.push(`${hostId}:${String(groupPath)}`);
    },
  });
  assert.equal(moved, true);
  assert.deepEqual(calls, ['host-1:null']);
  assert.equal(dispatchVaultHostGroupMove({
    hostIds: [],
    groupPath: 'Ops',
    moveHostsToGroup: () => {
      throw new Error('empty selection must not move');
    },
  }), false);
});
