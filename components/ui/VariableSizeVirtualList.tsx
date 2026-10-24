import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cn } from '../../lib/utils';
import { clampScrollTop } from './virtualListMath';

const DEFAULT_OVERSCAN = 6;

export type VariableSizeVirtualListHandle = {
  scrollToIndex: (index: number, align?: 'auto' | 'center') => void;
  /** Read clientHeight and restore parked scroll after a display:none ancestor. */
  remeasure: () => void;
};

interface VariableSizeVirtualListProps<T> {
  items: T[];
  getItemHeight: (item: T, index: number) => number;
  className?: string;
  contentClassName?: string;
  overscan?: number;
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
  /**
   * When false, a 0 clientHeight does not collapse the window or accept a
   * scroll reset. History parks under display:none; turning this back on
   * remeasures and re-anchors the parked offset.
   */
  measureEnabled?: boolean;
}

function findOffsetIndex(offsets: number[], scrollTop: number): number {
  if (offsets.length === 0) return 0;
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if ((offsets[mid] ?? 0) <= scrollTop) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function VariableSizeVirtualListInner<T>(
  {
    items,
    getItemHeight,
    className,
    contentClassName,
    overscan = DEFAULT_OVERSCAN,
    getItemKey,
    renderItem,
    measureEnabled = true,
  }: VariableSizeVirtualListProps<T>,
  ref: React.ForwardedRef<VariableSizeVirtualListHandle>,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const scrollTopRef = useRef(0);
  const measureEnabledRef = useRef(measureEnabled);
  const itemsRef = useRef(items);
  const getItemHeightRef = useRef(getItemHeight);
  measureEnabledRef.current = measureEnabled;
  itemsRef.current = items;
  getItemHeightRef.current = getItemHeight;

  const layout = useMemo(() => {
    const offsets: number[] = [];
    let total = 0;
    for (let i = 0; i < items.length; i += 1) {
      offsets.push(total);
      total += getItemHeight(items[i], i);
    }
    return { offsets, totalHeight: total };
  }, [getItemHeight, items]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const effectiveScrollTop = clampScrollTop(
    scrollTop,
    layout.totalHeight,
    viewportHeight,
  );

  // Sync DOM when content shrinks; render path already uses effectiveScrollTop.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (container.scrollTop !== effectiveScrollTop) {
      container.scrollTop = effectiveScrollTop;
    }
    scrollTopRef.current = effectiveScrollTop;
    if (scrollTop !== effectiveScrollTop) {
      setScrollTop(effectiveScrollTop);
    }
  }, [effectiveScrollTop, scrollTop]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateViewportHeight = () => {
      const next = container.clientHeight;
      // display:none reports 0. Dropping the window here unmounts the parked
      // rows; the next show would rebuild them until the user resizes.
      if (!measureEnabledRef.current && next === 0) return;
      setViewportHeight((current) => (current === next ? current : next));
    };

    updateViewportHeight();
    const observer = new ResizeObserver(updateViewportHeight);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const scrollToIndex = useCallback((index: number, align: 'auto' | 'center' = 'auto') => {
    const container = containerRef.current;
    const currentItems = itemsRef.current;
    const offsets = layoutRef.current.offsets;
    if (!container || index < 0 || index >= currentItems.length) return;

    const itemTop = offsets[index] ?? 0;
    const itemHeight = getItemHeightRef.current(currentItems[index] as T, index);
    const itemBottom = itemTop + itemHeight;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;

    if (align === 'center') {
      container.scrollTop = Math.max(
        0,
        itemTop - (container.clientHeight - itemHeight) / 2,
      );
    } else if (itemTop < viewTop) {
      container.scrollTop = itemTop;
    } else if (itemBottom > viewBottom) {
      container.scrollTop = itemBottom - container.clientHeight;
    }
    scrollTopRef.current = container.scrollTop;
    setScrollTop(container.scrollTop);
  }, []);

  const remeasure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const nextHeight = container.clientHeight;
    if (!measureEnabledRef.current && nextHeight === 0) return;
    if (nextHeight > 0) {
      setViewportHeight((current) => (current === nextHeight ? current : nextHeight));
    }
    const currentItems = itemsRef.current;
    const anchor = scrollTopRef.current;
    if (nextHeight <= 0 || currentItems.length === 0) return;
    const offsets = layoutRef.current.offsets;
    const index = findOffsetIndex(offsets, anchor);
    const itemTop = offsets[index] ?? 0;
    const itemHeight = getItemHeightRef.current(currentItems[index] as T, index);
    const itemBottom = itemTop + itemHeight;
    const intersects = itemTop < anchor + nextHeight && itemBottom > anchor;
    // A display:none ancestor often zeros scrollTop. Put the parked offset
    // back before scrollToIndex, or "already visible" is computed against 0
    // and the list jumps.
    if (container.scrollTop !== anchor) {
      container.scrollTop = anchor;
    }
    if (!intersects) {
      scrollToIndex(index, 'auto');
      return;
    }
    scrollTopRef.current = container.scrollTop;
    setScrollTop((current) => (current === container.scrollTop ? current : container.scrollTop));
  }, [scrollToIndex]);

  useImperativeHandle(ref, () => ({
    scrollToIndex,
    remeasure,
  }), [remeasure, scrollToIndex]);

  useLayoutEffect(() => {
    if (!measureEnabled) return;
    remeasure();
    // Parent layout effects move the side-panel portal out of the hidden
    // parking host after this effect. Remeasure once that move has landed.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) remeasure();
    });
    return () => {
      cancelled = true;
    };
  }, [measureEnabled, remeasure]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (!measureEnabledRef.current) return;
    scrollTopRef.current = event.currentTarget.scrollTop;
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const { startIndex, endIndex } = useMemo(() => {
    if (items.length === 0) {
      return { startIndex: 0, endIndex: 0 };
    }

    const { offsets } = layout;

    // First visible row: largest index whose top <= effectiveScrollTop.
    let lo = 0;
    let hi = items.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if ((offsets[mid] ?? 0) <= effectiveScrollTop) lo = mid;
      else hi = mid - 1;
    }
    const start = Math.max(0, lo - overscan);

    const viewBottom = effectiveScrollTop + viewportHeight;
    let scan = start;
    while (scan < items.length && (offsets[scan] ?? 0) < viewBottom + overscan * 40) {
      scan += 1;
    }
    const end = Math.min(items.length, scan + overscan);

    return { startIndex: start, endIndex: end };
  }, [effectiveScrollTop, items.length, layout, overscan, viewportHeight]);

  return (
    <div
      ref={containerRef}
      className={cn('h-full overflow-y-auto overflow-x-hidden', className)}
      onScroll={handleScroll}
    >
      <div
        className={cn('relative w-full', contentClassName)}
        style={{
          height: layout.totalHeight || undefined,
          minHeight: items.length === 0 ? 0 : layout.totalHeight,
        }}
      >
        {items.slice(startIndex, endIndex).map((item, offset) => {
          const index = startIndex + offset;
          const top = layout.offsets[index] ?? 0;
          const height = getItemHeight(item, index);
          return (
            <div
              key={getItemKey(item, index)}
              className="absolute left-0 right-0"
              style={{ top, height }}
            >
              {renderItem(item, index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const VariableSizeVirtualList = forwardRef(VariableSizeVirtualListInner) as <T>(
  props: VariableSizeVirtualListProps<T> & { ref?: React.ForwardedRef<VariableSizeVirtualListHandle> },
) => React.ReactElement | null;
