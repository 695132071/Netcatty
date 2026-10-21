import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MARQUEE_MOVEMENT_THRESHOLD_PX,
  clientPointToContent,
  contentRectFromClientBox,
  exceedsMarqueeThreshold,
  hostIdsIntersectingMarquee,
  isPointerOnNativeScrollbar,
  marqueeAutoScrollDelta,
  marqueeCancelSelection,
  marqueeCommitSelection,
  marqueeRectFromPoints,
  marqueeSelectionMode,
  mergeMarqueeSelection,
  rememberHostPlacements,
  shouldStartVaultMarquee,
  type HostPlacement,
} from './vaultMarqueeSelection.ts';

const box = (left: number, top: number, right: number, bottom: number) => ({
  left, top, right, bottom,
});

test('marquee rect normalizes a drag that moves up and left', () => {
  assert.deepEqual(
    marqueeRectFromPoints({ x: 40, y: 50 }, { x: 10, y: 20 }),
    box(10, 20, 40, 50),
  );
});

test('marquee movement threshold keeps a plain click below 4px', () => {
  const start = { x: 10, y: 10 };
  assert.equal(exceedsMarqueeThreshold(start, { x: 13, y: 12 }), false);
  assert.equal(
    exceedsMarqueeThreshold(start, { x: 10 + MARQUEE_MOVEMENT_THRESHOLD_PX, y: 10 }),
    true,
  );
  assert.equal(exceedsMarqueeThreshold(start, { x: 10, y: 14 }), true);
});

test('marquee modifiers replace, add with shift, and toggle with ctrl or meta', () => {
  assert.equal(marqueeSelectionMode({ shiftKey: false, ctrlKey: false, metaKey: false }), 'replace');
  assert.equal(marqueeSelectionMode({ shiftKey: true, ctrlKey: false, metaKey: false }), 'add');
  assert.equal(marqueeSelectionMode({ shiftKey: false, ctrlKey: true, metaKey: false }), 'toggle');
  assert.equal(marqueeSelectionMode({ shiftKey: false, ctrlKey: false, metaKey: true }), 'toggle');
  assert.equal(marqueeSelectionMode({ shiftKey: true, ctrlKey: true, metaKey: false }), 'toggle');
});

test('marquee selection merge uses the selection from drag start', () => {
  const baseline = new Set(['a', 'b']);
  const hits = new Set(['b', 'c']);

  assert.deepEqual([...mergeMarqueeSelection(baseline, hits, 'replace')].sort(), ['b', 'c']);
  assert.deepEqual([...mergeMarqueeSelection(baseline, hits, 'add')].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...mergeMarqueeSelection(baseline, hits, 'toggle')].sort(), ['a', 'c']);
  assert.deepEqual([...baseline].sort(), ['a', 'b']);
});

test('host cards that intersect the marquee are selected, including partial overlap', () => {
  const placements = [
    { id: 'inside', rect: box(10, 10, 30, 30) },
    { id: 'partial', rect: box(28, 28, 50, 50) },
    { id: 'touch', rect: box(40, 10, 55, 20) },
    { id: 'miss', rect: box(41, 10, 60, 20) },
  ];

  assert.deepEqual(
    [...hostIdsIntersectingMarquee(box(0, 0, 40, 40), placements)].sort(),
    ['inside', 'partial'],
  );
});

test('placement cache keeps hosts that scroll out of the mounted set', () => {
  const cache = new Map<string, HostPlacement>();
  rememberHostPlacements(cache, [
    { key: 'main:a', id: 'a', rect: box(0, 0, 10, 10) },
    { key: 'pinned:a', id: 'a', rect: box(0, 100, 10, 110) },
    { key: 'main:b', id: 'b', rect: box(0, 20, 10, 30) },
  ]);
  rememberHostPlacements(cache, [
    { key: 'main:b', id: 'b', rect: box(0, 20, 12, 30) },
    { key: 'main:c', id: 'c', rect: box(0, 40, 10, 50) },
  ]);

  const hits = hostIdsIntersectingMarquee(box(0, 0, 10, 50), cache.values());
  assert.deepEqual([...hits].sort(), ['a', 'b', 'c']);
  assert.equal(cache.get('main:b')?.rect.right, 12);
});

test('content coordinates stay stable when the scroll container moves', () => {
  const frame = {
    left: 100,
    top: 40,
    scrollLeft: 0,
    scrollTop: 25,
    clientLeft: 0,
    clientTop: 0,
  };
  assert.deepEqual(clientPointToContent({ x: 130, y: 80 }, frame), { x: 30, y: 65 });

  const beforeScroll = contentRectFromClientBox(
    { left: 120, top: 70, width: 40, height: 20 },
    frame,
  );
  const afterScroll = contentRectFromClientBox(
    { left: 120, top: 50, width: 40, height: 20 },
    { ...frame, scrollTop: 45 },
  );
  assert.deepEqual(beforeScroll, afterScroll);
  assert.deepEqual(beforeScroll, box(20, 55, 60, 75));
});

test('auto-scroll only steps when the pointer is near a vertical edge', () => {
  assert.equal(marqueeAutoScrollDelta(10, 0, 200), -16);
  assert.equal(marqueeAutoScrollDelta(190, 0, 200), 16);
  assert.equal(marqueeAutoScrollDelta(100, 0, 200), 0);
});

test('native scrollbar gutter does not start a marquee', () => {
  const metrics = {
    rectLeft: 0,
    rectTop: 0,
    clientLeft: 0,
    clientTop: 0,
    clientWidth: 200,
    clientHeight: 300,
  };
  assert.equal(isPointerOnNativeScrollbar(metrics, 190, 40), false);
  assert.equal(isPointerOnNativeScrollbar(metrics, 210, 40), true);
  assert.equal(isPointerOnNativeScrollbar(metrics, 20, 310), true);
});

test('marquee starts on primary grid or list presses in empty space only', () => {
  const ready = {
    viewMode: 'grid',
    button: 0,
    pointerType: 'mouse',
    onScrollbar: false,
    blockedTarget: false,
  };
  assert.equal(shouldStartVaultMarquee(ready), true);
  assert.equal(shouldStartVaultMarquee({ ...ready, viewMode: 'list' }), true);
  assert.equal(shouldStartVaultMarquee({ ...ready, viewMode: 'tree' }), false);
  assert.equal(shouldStartVaultMarquee({ ...ready, button: 2 }), false);
  assert.equal(shouldStartVaultMarquee({ ...ready, pointerType: 'touch' }), false);
  assert.equal(shouldStartVaultMarquee({ ...ready, onScrollbar: true }), false);
  assert.equal(shouldStartVaultMarquee({ ...ready, blockedTarget: true }), false);
});

test('committing a marquee enters multi-select only when hosts are selected', () => {
  assert.deepEqual(
    marqueeCommitSelection({ wasMultiSelectMode: false, nextIds: new Set(['a']) }),
    { isMultiSelectMode: true, selectedHostIds: new Set(['a']) },
  );
  assert.deepEqual(
    marqueeCommitSelection({ wasMultiSelectMode: false, nextIds: new Set() }),
    { isMultiSelectMode: false, selectedHostIds: new Set() },
  );
  assert.deepEqual(
    marqueeCommitSelection({ wasMultiSelectMode: true, nextIds: new Set() }),
    { isMultiSelectMode: true, selectedHostIds: new Set() },
  );
});

test('escape restores the selection captured at drag start', () => {
  assert.deepEqual(
    marqueeCancelSelection({
      wasMultiSelectMode: false,
      baselineIds: new Set(['kept']),
    }),
    { isMultiSelectMode: false, selectedHostIds: new Set(['kept']) },
  );
});
