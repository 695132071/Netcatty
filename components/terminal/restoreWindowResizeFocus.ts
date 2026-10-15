import { hasOpenAppDialog } from "./focusTerminalSession";

/** Debounce so a continuous frame drag (or maximize transition) triggers one restore. */
export const WINDOW_RESIZE_RESTORE_FOCUS_DELAY_MS = 120;

export type MinimalWindow = {
  addEventListener?: (type: string, listener: () => void) => unknown;
  removeEventListener?: (type: string, listener: () => void) => unknown;
};

export type MinimalActiveElement = {
  tagName?: string | null;
  isContentEditable?: boolean;
  matches?: (selector: string) => boolean;
};

export type MinimalDocument = Parameters<typeof hasOpenAppDialog>[0] & {
  hasFocus?: () => boolean;
  activeElement?: MinimalActiveElement | null;
};

/**
 * True when keyboard focus sits in an editable app field (search box, chat
 * input, SFTP filter, inline rename, ...) that is not an xterm helper
 * textarea. Resize-driven restores must not yank focus away from such fields.
 * Focus parked on `body`/`html` (or an xterm helper textarea) does not count
 * as editing another field.
 */
export const hasActiveEditableElement = (doc: MinimalDocument | null): boolean => {
  const element = doc?.activeElement;
  if (!element) return false;
  if (typeof element.matches === "function" && element.matches("textarea.xterm-helper-textarea")) {
    return false;
  }
  const tagName = typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
  return (
    tagName === "input"
    || tagName === "textarea"
    || tagName === "select"
    || Boolean(element.isContentEditable)
  );
};

type AttachWindowResizeFocusRestoreOptions = {
  win?: MinimalWindow | null;
  doc?: MinimalDocument | null;
  refocus?: () => void;
  delayMs?: number;
  scheduleTimeout?: (callback: () => void, delay: number) => unknown;
  cancelTimeout?: (id: unknown) => void;
};

/**
 * #3647: dragging the OS window frame (or maximizing) leaves the active xterm
 * helper textarea unfocused, so keystrokes do nothing until the user clicks
 * back into the terminal. Attach a window `resize` listener that re-runs the
 * tab-change refocus path after the resize settles.
 *
 * Restore is skipped when the app window does not hold OS input focus, when a
 * modal dialog is open, or when an editable element other than the xterm
 * helper textarea already holds focus, so the restore never steals typing
 * from elsewhere.
 */
export const attachWindowResizeFocusRestore = (
  {
    win = typeof window !== "undefined" ? window : null,
    doc = typeof document !== "undefined" ? document : null,
    refocus,
    delayMs = WINDOW_RESIZE_RESTORE_FOCUS_DELAY_MS,
    scheduleTimeout = (callback: () => void, delay: number) => setTimeout(callback, delay),
    cancelTimeout = (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  }: AttachWindowResizeFocusRestoreOptions = {},
): (() => void) => {
  if (!win?.addEventListener || !win.removeEventListener || typeof refocus !== "function") {
    return () => {};
  }

  let timerId: unknown = null;
  const restoreFocus = () => {
    timerId = null;
    if (doc?.hasFocus?.() === false) return;
    if (hasOpenAppDialog(doc)) return;
    // The window holds OS focus, but the user may still be typing in a
    // non-terminal field (terminal search, AI chat, SFTP filter, rename).
    // Never steal focus from an active editable element.
    if (hasActiveEditableElement(doc)) return;
    refocus();
  };
  const handleResize = () => {
    if (timerId !== null) {
      cancelTimeout(timerId);
    }
    timerId = scheduleTimeout(restoreFocus, delayMs);
  };

  win.addEventListener("resize", handleResize);
  return () => {
    win.removeEventListener("resize", handleResize);
    if (timerId !== null) {
      cancelTimeout(timerId);
      timerId = null;
    }
  };
};
