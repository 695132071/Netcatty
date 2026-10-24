import type React from "react";

/**
 * The DOM `MouseEvent.button` value for the middle mouse button (wheel click).
 * 0 = left/primary, 1 = middle, 2 = right/secondary.
 */
export const MIDDLE_MOUSE_BUTTON = 1;

/**
 * Suppress the Chromium/Electron middle-click autoscroll affordance on a tab.
 * Wire to `onMouseDown`: autoscroll is armed on mousedown, so preventing the
 * default there stops the panning-cursor overlay from appearing when a user
 * middle-clicks a tab to close it (#1044).
 */
export const handleTabMiddleMouseDown = (e: React.MouseEvent): void => {
  if (e.button === MIDDLE_MOUSE_BUTTON) {
    e.preventDefault();
  }
};

/**
 * Keep a primary-button press on a tab close control from starting an HTML5
 * drag on the ancestor `draggable` tab. Chromium promotes a few pixels of
 * movement between mousedown and mouseup into `dragstart`, which swallows the
 * click (#3886). `preventDefault` stops that drag; `stopPropagation` keeps the
 * tab's own mousedown handler from seeing the press. Middle and right buttons
 * are left alone so aux-click close and context menus stay unchanged.
 */
export const handleTabCloseButtonMouseDown = (e: React.MouseEvent): void => {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
};

/**
 * Pointer travel below this is a click, not a tab reorder. Chromium can fire
 * `dragstart` after about 2px on a `draggable` tab and cancel the click that
 * would activate it (#3886).
 */
export const TAB_DRAG_THRESHOLD_PX = 4;

type TabPress = {
  x: number;
  y: number;
  dragStartFired: boolean;
  reorderStarted: boolean;
};

let tabPress: TabPress | null = null;

const pointerDistanceFrom = (press: TabPress, x: number, y: number): number =>
  Math.hypot(x - press.x, y - press.y);

const pointerDistance = (x: number, y: number): number => {
  if (!tabPress) return Number.POSITIVE_INFINITY;
  return pointerDistanceFrom(tabPress, x, y);
};

/**
 * Record a primary-button press on a draggable tab root, and keep middle-click
 * autoscroll suppression. Wire to the tab root `onMouseDown`. Non-primary
 * buttons are not tracked, so they cannot cancel a later drag.
 */
export const handleTabDragThresholdMouseDown = (e: React.MouseEvent): void => {
  handleTabMiddleMouseDown(e);
  if (e.button !== 0) return;
  tabPress = { x: e.clientX, y: e.clientY, dragStartFired: false, reorderStarted: false };
};

/**
 * Note that `dragstart` fired. Never `preventDefault` here: cancelling the
 * only `dragstart` aborts the HTML drag, so a slow reorder cannot continue
 * (#3886). Returns true when travel is still below the reorder threshold.
 * Callers still invoke `onTabDragStart` so the drag payload can be written
 * while DataTransfer is writable; reorder chrome waits for
 * `isTabDragReorderStarted`.
 */
export const handleTabDragThresholdDragStart = (e: React.DragEvent): boolean => {
  if (!tabPress) return false;
  tabPress.dragStartFired = true;
  if (pointerDistance(e.clientX, e.clientY) < TAB_DRAG_THRESHOLD_PX) return true;
  tabPress.reorderStarted = true;
  return false;
};

/** True when this gesture should show reorder chrome, or there is no tracked press. */
export const isTabDragReorderStarted = (): boolean =>
  !tabPress || tabPress.reorderStarted;

/**
 * `dragstart` only fires once. Later travel arrives as `drag`. Returns true
 * the first time that travel reaches the reorder threshold.
 */
export const handleTabDragThresholdDrag = (e: React.DragEvent): boolean => {
  if (!tabPress?.dragStartFired || tabPress.reorderStarted) return false;
  if (pointerDistance(e.clientX, e.clientY) < TAB_DRAG_THRESHOLD_PX) return false;
  tabPress.reorderStarted = true;
  return true;
};

type TabReleasePoint = {
  button?: number;
  clientX: number;
  clientY: number;
};

/**
 * Activate when `dragstart` already cancelled the click, the pointer stayed
 * below the reorder threshold, and no reorder started. Wire to `mouseup` and
 * `dragend` (Chromium delivers `dragend` after an uncancelled drag). A second
 * call in the same gesture does not activate again.
 */
export const handleTabDragThresholdRelease = (
  event: TabReleasePoint,
  activate: () => void,
): void => {
  const press = tabPress;
  tabPress = null;
  if (!press?.dragStartFired || press.reorderStarted) return;
  if (event.button != null && event.button !== 0) return;
  if (pointerDistanceFrom(press, event.clientX, event.clientY) >= TAB_DRAG_THRESHOLD_PX) return;
  activate();
};

/** Drop a tracked press so the next gesture starts clean. */
export const handleTabDragThresholdReset = (): void => {
  tabPress = null;
};

/**
 * Close a tab when it is middle-clicked. Wire to `onAuxClick`, which fires for
 * a completed non-primary click. Left clicks (tab activation) and right clicks
 * (context menu) are ignored so existing behavior is untouched.
 */
export const handleTabMiddleClickClose = (
  e: React.MouseEvent,
  close: () => void,
): void => {
  if (e.button !== MIDDLE_MOUSE_BUTTON) return;
  e.preventDefault();
  e.stopPropagation();
  close();
};
