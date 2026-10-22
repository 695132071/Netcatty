import type { BrowserBookmark } from './browserBookmark';

export class HostBrowserIconError extends Error {
  constructor(public readonly reason: 'file-type' | 'file-size' | 'decode') {
    super(reason);
    this.name = 'HostBrowserIconError';
  }
}

export interface HostBrowserTab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  iconDataUrl: string | null;
  iconGlyph: string | null;
  iconColor: string | null;
}

export interface HostBrowserState {
  hostId: string;
  label: string;
  route: 'connecting' | 'connected' | 'disconnected';
  error: string | null;
  activeTabId: string | null;
  tabs: HostBrowserTab[];
}

export interface HostBrowserDownload {
  id: string;
  hostId: string;
  filename: string;
  url: string;
  savePath: string;
  status: 'waiting' | 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  received: number;
  total: number;
  startedAt: number;
  endedAt: number | null;
  missing: boolean;
}

export type HostBrowserBookmark = BrowserBookmark & {
  siteIconDataUrl?: string | null;
  siteIconGlyph?: string | null;
  siteIconColor?: string | null;
};

export type HostBrowserCommand =
  | { type: 'new-tab'; url?: string }
  | { type: 'navigate'; url: string; tabId?: string }
  | { type: 'activate' | 'close-tab' | 'back' | 'forward' | 'reload' | 'stop' | 'reset-icon'; tabId?: string }
  | { type: 'reorder'; tabId: string; beforeTabId: string }
  | { type: 'set-icon'; tabId: string; dataUrl?: string | null; glyph: string; color: string }
  | { type: 'retry' };

export type HostBrowserShortcut = { type: 'focus-address' | 'new-tab' | 'close-tab' | 'reload'; tabId: string };
export type HostBrowserPanelEvent = { browserId: string } & (
  | { type: 'state'; state: HostBrowserState }
  | { type: 'downloads'; downloads: HostBrowserDownload[]; startedId?: string }
  | { type: 'bookmarks' }
  | { type: 'shortcut'; shortcut: HostBrowserShortcut }
);

export interface HostBrowserPaneRect { x: number; y: number; width: number; height: number }

/** Below this extent a page beside an overlay panel is too cramped to keep live. */
export const HOST_BROWSER_MIN_LIVE_EXTENT = 160;

/**
 * Native browser views draw above the renderer and cannot be clipped, so a
 * panel covering a full-height or full-width edge strip of the pane is avoided
 * by shrinking the page to the remaining rectangle. Returns null when a panel
 * covers the middle or leaves too little room; the pane then shows a picture.
 */
export function resolveHostBrowserPaneBesidePanels(
  pane: HostBrowserPaneRect,
  panels: readonly HostBrowserPaneRect[],
): HostBrowserPaneRect | null {
  let left = pane.x;
  let top = pane.y;
  let right = pane.x + pane.width;
  let bottom = pane.y + pane.height;
  for (const panel of panels) {
    const panelRight = panel.x + panel.width;
    const panelBottom = panel.y + panel.height;
    if (panel.x >= right || panelRight <= left || panel.y >= bottom || panelBottom <= top) continue;
    const spansHeight = panel.y <= top && panelBottom >= bottom;
    const spansWidth = panel.x <= left && panelRight >= right;
    if (spansHeight && panel.x > left && panelRight >= right) right = panel.x;
    else if (spansHeight && panel.x <= left && panelRight < right) left = panelRight;
    else if (spansWidth && panel.y > top && panelBottom >= bottom) bottom = panel.y;
    else if (spansWidth && panel.y <= top && panelBottom < bottom) top = panelBottom;
    else return null;
  }
  if (left === pane.x && top === pane.y && right === pane.x + pane.width && bottom === pane.y + pane.height) return pane;
  if (right - left < HOST_BROWSER_MIN_LIVE_EXTENT || bottom - top < HOST_BROWSER_MIN_LIVE_EXTENT) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
