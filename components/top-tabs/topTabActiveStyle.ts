/**
 * Stable hooks for the selected top tab.
 *
 * Defaults fall through to the existing chrome colors, so leaving the custom
 * properties unset keeps today's look. Custom CSS can set them on
 * `.top-tab[data-active="true"]` (or any ancestor) without !important.
 * `--top-tab-active-border` is read by index.css as a 1px inset outline and
 * defaults to transparent.
 */

export const TOP_TAB_ITEM_CLASS = 'top-tab';

/** Previous selected fill, kept as the fallback when the hook is unset. */
export const TOP_TAB_LEGACY_ACTIVE_BG = 'var(--top-tabs-active-bg, hsl(var(--background)))';

/** Previous selected label color, kept as the fallback when the hook is unset. */
export const TOP_TAB_LEGACY_ACTIVE_FG = 'var(--top-tabs-fg, hsl(var(--foreground)))';

export const TOP_TAB_ACTIVE_BG = `var(--top-tab-active-bg, ${TOP_TAB_LEGACY_ACTIVE_BG})`;

export const TOP_TAB_ACTIVE_FG = `var(--top-tab-active-fg, ${TOP_TAB_LEGACY_ACTIVE_FG})`;

export const TOP_TAB_ACTIVE_BORDER = 'var(--top-tab-active-border, transparent)';

export const TOP_TAB_INACTIVE_FG = 'var(--top-tabs-muted, hsl(var(--muted-foreground)))';

/** Same 40% mix as the previous hover fill. The inner color is the active-tab hook. */
export const TOP_TAB_HOVER_BG = `color-mix(in srgb, ${TOP_TAB_ACTIVE_BG} 40%, transparent)`;

export const TOP_TAB_ACTIVE_OUTLINE = `1px solid ${TOP_TAB_ACTIVE_BORDER}`;

export function topTabActiveValue(isActive: boolean): 'true' | 'false' {
  return isActive ? 'true' : 'false';
}

export interface TopTabChromeStyle {
  backgroundColor: string;
  color: string;
}

export function resolveTopTabChromeStyle(
  isActive: boolean,
  options?: { suppressActiveBg?: boolean },
): TopTabChromeStyle {
  if (!isActive) {
    return {
      backgroundColor: 'transparent',
      color: TOP_TAB_INACTIVE_FG,
    };
  }

  return {
    backgroundColor: options?.suppressActiveBg ? 'transparent' : TOP_TAB_ACTIVE_BG,
    color: TOP_TAB_ACTIVE_FG,
  };
}

type TopTabStyleTarget = {
  style: {
    backgroundColor: string;
    color: string;
  };
};

export function paintInactiveTopTabHover(element: TopTabStyleTarget): void {
  element.style.backgroundColor = TOP_TAB_HOVER_BG;
  element.style.color = TOP_TAB_ACTIVE_FG;
}

export function clearInactiveTopTabHover(element: TopTabStyleTarget): void {
  element.style.backgroundColor = 'transparent';
  element.style.color = TOP_TAB_INACTIVE_FG;
}
