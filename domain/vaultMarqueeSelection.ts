export const MARQUEE_MOVEMENT_THRESHOLD_PX = 4;
export const MARQUEE_AUTOSCROLL_EDGE_PX = 28;
export const MARQUEE_AUTOSCROLL_STEP_PX = 16;

export interface MarqueePoint {
  x: number;
  y: number;
}

export interface MarqueeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MarqueeContentFrame {
  left: number;
  top: number;
  scrollLeft: number;
  scrollTop: number;
  clientLeft?: number;
  clientTop?: number;
}

export interface ScrollbarMetrics {
  rectLeft: number;
  rectTop: number;
  clientLeft: number;
  clientTop: number;
  clientWidth: number;
  clientHeight: number;
}

export type MarqueeSelectionMode = 'replace' | 'add' | 'toggle';

export interface HostPlacement {
  key: string;
  id: string;
  rect: MarqueeRect;
}

export function marqueeRectFromPoints(start: MarqueePoint, current: MarqueePoint): MarqueeRect {
  return {
    left: Math.min(start.x, current.x),
    top: Math.min(start.y, current.y),
    right: Math.max(start.x, current.x),
    bottom: Math.max(start.y, current.y),
  };
}

export function exceedsMarqueeThreshold(
  start: MarqueePoint,
  current: MarqueePoint,
  threshold = MARQUEE_MOVEMENT_THRESHOLD_PX,
): boolean {
  return Math.abs(current.x - start.x) >= threshold || Math.abs(current.y - start.y) >= threshold;
}

export function marqueeSelectionMode(modifiers: {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): MarqueeSelectionMode {
  if (modifiers.ctrlKey || modifiers.metaKey) return 'toggle';
  if (modifiers.shiftKey) return 'add';
  return 'replace';
}

export function rectsIntersect(a: MarqueeRect, b: MarqueeRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function mergeMarqueeSelection(
  baseline: ReadonlySet<string>,
  hitIds: ReadonlySet<string>,
  mode: MarqueeSelectionMode,
): Set<string> {
  if (mode === 'replace') return new Set(hitIds);
  const next = new Set(baseline);
  for (const id of hitIds) {
    if (mode === 'toggle' && next.has(id)) next.delete(id);
    else next.add(id);
  }
  return next;
}

export function hostIdsIntersectingMarquee(
  marquee: MarqueeRect,
  placements: Iterable<{ id: string; rect: MarqueeRect }>,
): Set<string> {
  const hits = new Set<string>();
  for (const placement of placements) {
    if (rectsIntersect(marquee, placement.rect)) hits.add(placement.id);
  }
  return hits;
}

export function rememberHostPlacements(
  cache: Map<string, HostPlacement>,
  visible: readonly HostPlacement[],
): Map<string, HostPlacement> {
  for (const placement of visible) cache.set(placement.key, placement);
  return cache;
}

export function clientPointToContent(client: MarqueePoint, frame: MarqueeContentFrame): MarqueePoint {
  return {
    x: client.x - frame.left - (frame.clientLeft ?? 0) + frame.scrollLeft,
    y: client.y - frame.top - (frame.clientTop ?? 0) + frame.scrollTop,
  };
}

export function contentRectFromClientBox(
  box: { left: number; top: number; width: number; height: number },
  frame: MarqueeContentFrame,
): MarqueeRect {
  const origin = clientPointToContent({ x: box.left, y: box.top }, frame);
  return {
    left: origin.x,
    top: origin.y,
    right: origin.x + box.width,
    bottom: origin.y + box.height,
  };
}

export function marqueeAutoScrollDelta(
  client: number,
  start: number,
  end: number,
  edge = MARQUEE_AUTOSCROLL_EDGE_PX,
  step = MARQUEE_AUTOSCROLL_STEP_PX,
): number {
  if (client < start + edge) return -step;
  if (client > end - edge) return step;
  return 0;
}

export function isPointerOnNativeScrollbar(
  metrics: ScrollbarMetrics,
  clientX: number,
  clientY: number,
): boolean {
  const x = clientX - metrics.rectLeft - metrics.clientLeft;
  const y = clientY - metrics.rectTop - metrics.clientTop;
  return x > metrics.clientWidth || y > metrics.clientHeight;
}

export function shouldStartVaultMarquee(input: {
  viewMode: string;
  button: number;
  pointerType?: string;
  onScrollbar: boolean;
  blockedTarget: boolean;
}): boolean {
  if (input.viewMode !== 'grid' && input.viewMode !== 'list') return false;
  if (input.button !== 0) return false;
  if (input.pointerType === 'touch') return false;
  if (input.onScrollbar || input.blockedTarget) return false;
  return true;
}

export function marqueeCommitSelection(input: {
  wasMultiSelectMode: boolean;
  nextIds: ReadonlySet<string>;
}): { isMultiSelectMode: boolean; selectedHostIds: Set<string> } {
  const selectedHostIds = new Set(input.nextIds);
  return {
    isMultiSelectMode: selectedHostIds.size > 0 || input.wasMultiSelectMode,
    selectedHostIds,
  };
}

export function marqueeCancelSelection(input: {
  wasMultiSelectMode: boolean;
  baselineIds: ReadonlySet<string>;
}): { isMultiSelectMode: boolean; selectedHostIds: Set<string> } {
  return {
    isMultiSelectMode: input.wasMultiSelectMode,
    selectedHostIds: new Set(input.baselineIds),
  };
}
