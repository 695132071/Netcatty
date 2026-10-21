import React, { useCallback, useEffect, useRef, useState } from "react";

import {
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
  type MarqueeContentFrame,
  type MarqueeRect,
} from "../../domain/vaultMarqueeSelection";

const MARQUEE_BLOCKED_SELECTOR = [
  "[data-host-id]",
  "[data-group-path]",
  "button",
  "input",
  "textarea",
  "select",
  "a",
  "label",
  "[role='scrollbar']",
].join(",");

const selectionSignature = (ids: ReadonlySet<string>) => [...ids].sort().join("\0");

const elementFromEventTarget = (target: EventTarget | null): Element | null => {
  if (target instanceof Element) return target;
  if (typeof Node !== "undefined" && target instanceof Node) return target.parentElement;
  return null;
};

const isBlockedMarqueeTarget = (target: EventTarget | null): boolean => {
  const element = elementFromEventTarget(target);
  if (!element) return true;
  return Boolean(element.closest(MARQUEE_BLOCKED_SELECTOR));
};

const readFrame = (container: HTMLElement): MarqueeContentFrame => {
  const rect = container.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    scrollLeft: container.scrollLeft,
    scrollTop: container.scrollTop,
    clientLeft: container.clientLeft,
    clientTop: container.clientTop,
  };
};

const readVisibleHostPlacements = (container: HTMLElement): HostPlacement[] => {
  const frame = readFrame(container);
  const placements: HostPlacement[] = [];
  container.querySelectorAll<HTMLElement>("[data-host-id]").forEach((node, index) => {
    const id = node.dataset.hostId;
    if (!id) return;
    const box = node.getBoundingClientRect();
    placements.push({
      key: node.dataset.vaultGridItem || `${id}:${index}`,
      id,
      rect: contentRectFromClientBox(box, frame),
    });
  });
  return placements;
};

interface UseVaultHostMarqueeOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  viewMode: string;
  isMultiSelectMode: boolean;
  selectedHostIds: ReadonlySet<string>;
  setIsMultiSelectMode?: (value: boolean) => void;
  setSelectedHostIds?: (ids: Set<string>) => void;
}

export function useVaultHostMarquee({
  containerRef,
  viewMode,
  isMultiSelectMode,
  selectedHostIds,
  setIsMultiSelectMode,
  setSelectedHostIds,
}: UseVaultHostMarqueeOptions) {
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null);
  const suppressClickRef = useRef(false);
  const sessionRef = useRef(0);
  const stopGestureRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopGestureRef.current?.(), []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (suppressClickRef.current) suppressClickRef.current = false;
    const container = containerRef.current;
    if (!container || !setSelectedHostIds || !setIsMultiSelectMode) return;
    const bounds = container.getBoundingClientRect();
    if (!shouldStartVaultMarquee({
      viewMode,
      button: event.button,
      pointerType: event.pointerType,
      onScrollbar: isPointerOnNativeScrollbar({
        rectLeft: bounds.left,
        rectTop: bounds.top,
        clientLeft: container.clientLeft,
        clientTop: container.clientTop,
        clientWidth: container.clientWidth,
        clientHeight: container.clientHeight,
      }, event.clientX, event.clientY),
      blockedTarget: isBlockedMarqueeTarget(event.target),
    })) return;

    stopGestureRef.current?.();
    const startContent = clientPointToContent(
      { x: event.clientX, y: event.clientY },
      readFrame(container),
    );
    const baseline = new Set(selectedHostIds);
    const wasMultiSelectMode = Boolean(isMultiSelectMode);
    const mode = marqueeSelectionMode(event);
    const cache = new Map<string, HostPlacement>();
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    let active = false;
    let scrollDelta = 0;
    let frameId = 0;
    let lastClientX = event.clientX;
    let lastClientY = event.clientY;
    let lastSignature = selectionSignature(baseline);
    let lastMode = wasMultiSelectMode;

    const publish = (nextIds: Set<string>, modeEnabled: boolean) => {
      const signature = selectionSignature(nextIds);
      if (signature !== lastSignature) {
        lastSignature = signature;
        setSelectedHostIds(nextIds);
      }
      if (modeEnabled !== lastMode) {
        lastMode = modeEnabled;
        setIsMultiSelectMode(modeEnabled);
      }
    };

    const applyAt = (clientX: number, clientY: number) => {
      if (sessionRef.current !== session) return;
      const current = clientPointToContent({ x: clientX, y: clientY }, readFrame(container));
      if (!active && !exceedsMarqueeThreshold(startContent, current)) return;
      active = true;
      const rect = marqueeRectFromPoints(startContent, current);
      rememberHostPlacements(cache, readVisibleHostPlacements(container));
      const hits = hostIdsIntersectingMarquee(rect, cache.values());
      const next = marqueeCommitSelection({
        wasMultiSelectMode,
        nextIds: mergeMarqueeSelection(baseline, hits, mode),
      });
      setMarqueeRect(rect);
      publish(next.selectedHostIds, next.isMultiSelectMode);
    };

    const listeners: {
      move?: (event: PointerEvent) => void;
      up?: () => void;
      cancel?: () => void;
      key?: (event: KeyboardEvent) => void;
      scroll?: () => void;
    } = {};
    let stopGesture = () => {};

    const finishListeners = () => {
      if (listeners.move) window.removeEventListener("pointermove", listeners.move);
      if (listeners.up) window.removeEventListener("pointerup", listeners.up);
      if (listeners.cancel) window.removeEventListener("pointercancel", listeners.cancel);
      if (listeners.key) window.removeEventListener("keydown", listeners.key);
      if (listeners.scroll) container.removeEventListener("scroll", listeners.scroll);
      if (frameId) cancelAnimationFrame(frameId);
      frameId = 0;
      scrollDelta = 0;
      if (stopGestureRef.current === stopGesture) stopGestureRef.current = null;
    };

    stopGesture = () => {
      if (sessionRef.current !== session) return;
      sessionRef.current += 1;
      finishListeners();
      setMarqueeRect(null);
    };

    const end = (cancel: boolean) => {
      if (sessionRef.current !== session) return;
      const wasActive = active;
      stopGesture();
      if (!wasActive) return;
      suppressClickRef.current = true;
      if (!cancel) return;
      const restored = marqueeCancelSelection({
        wasMultiSelectMode,
        baselineIds: baseline,
      });
      lastSignature = "";
      lastMode = !restored.isMultiSelectMode;
      publish(restored.selectedHostIds, restored.isMultiSelectMode);
    };

    const tick = () => {
      frameId = 0;
      if (!scrollDelta || sessionRef.current !== session) return;
      container.scrollTop += scrollDelta;
      frameId = window.requestAnimationFrame(tick);
    };

    listeners.move = (pointerEvent: PointerEvent) => {
      lastClientX = pointerEvent.clientX;
      lastClientY = pointerEvent.clientY;
      applyAt(pointerEvent.clientX, pointerEvent.clientY);
      if (active) {
        pointerEvent.preventDefault();
        window.getSelection?.()?.removeAllRanges();
      }
      const nextBounds = container.getBoundingClientRect();
      scrollDelta = active
        ? marqueeAutoScrollDelta(pointerEvent.clientY, nextBounds.top, nextBounds.bottom)
        : 0;
      if (scrollDelta && !frameId) frameId = window.requestAnimationFrame(tick);
      if (!scrollDelta && frameId) {
        cancelAnimationFrame(frameId);
        frameId = 0;
      }
    };

    listeners.scroll = () => {
      if (!active) return;
      applyAt(lastClientX, lastClientY);
    };
    listeners.up = () => end(false);
    listeners.cancel = () => end(true);
    listeners.key = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      if (!active) {
        end(false);
        return;
      }
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      end(true);
    };

    stopGestureRef.current = stopGesture;
    window.addEventListener("pointermove", listeners.move);
    window.addEventListener("pointerup", listeners.up);
    window.addEventListener("pointercancel", listeners.cancel);
    window.addEventListener("keydown", listeners.key);
    container.addEventListener("scroll", listeners.scroll, { passive: true });
  }, [
    containerRef,
    isMultiSelectMode,
    selectedHostIds,
    setIsMultiSelectMode,
    setSelectedHostIds,
    viewMode,
  ]);

  const onClickCapture = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return { marqueeRect, onPointerDown, onClickCapture };
}
