import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { currentBrowserThemeTokens, mountHostBrowser } from '../hostBrowser';
import type { Host, Identity, KnownHost, SSHKey, TerminalSettings } from '../../domain/models';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import type { HostBrowserPanelSnapshotLayer } from '../../types/global/netcatty-bridge-sync';

function overlapsBrowser(rect: DOMRect, element: Element): boolean {
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || element.closest('[hidden], [inert], [data-state="closed"]')) return false;
  const overlay = element.getBoundingClientRect();
  return overlay.width > 0 && overlay.height > 0
    && overlay.x < rect.right && overlay.right > rect.x
    && overlay.y < rect.bottom && overlay.bottom > rect.y;
}

interface BrowserPanelOptions {
  browserId: string;
  host: Host;
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  knownHosts: KnownHost[];
  terminalSettings: TerminalSettings;
  isVisible: boolean;
}

export function useHostBrowserPanel(options: BrowserPanelOptions) {
  const elementRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const opened = useRef(false);
  const mountedBrowserId = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [readyId, setReadyId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<{ browserId: string; layers: HostBrowserPanelSnapshotLayer[] } | null>(null);
  const { browserId, isVisible } = options;

  useLayoutEffect(() => {
    const bridge = netcattyBridge.get();
    let frame = 0;
    let previous = '';
    let disposed = false;
    const update = () => {
      const element = elementRef.current;
      const rect = element?.getBoundingClientRect();
      // Native views sit above renderer portals. Only overlapping poppers need
      // to yield; dialogs are modal even when their content is beside the pane.
      const locked = !!document.querySelector('[data-app-lock-overlay]');
      const modal = !!document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]');
      const covered = modal || (!!rect && Array.from(document.querySelectorAll(
        '[role="dialog"], [role="menu"][data-state="open"], [data-radix-popper-content-wrapper] > *',
      )).some((overlay) => overlapsBrowser(rect, overlay)));
      const visible = isVisible && !!element?.isConnected && !!rect
        && rect.width > 0 && rect.height > 0 && !element?.closest('[inert]') && !locked;
      if (!visible) setSnapshot(null);
      const bounds = rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined;
      const theme = element && getComputedStyle(element).colorScheme === 'light' ? 'light' : 'dark';
      const themeTokens = currentBrowserThemeTokens(element ?? undefined);
      const layout: Parameters<NonNullable<NetcattyBridge['setHostBrowserPanelLayout']>>[0] = {
        browserId, visible, occluded: visible && covered, bounds, theme, themeTokens,
      };
      const next = JSON.stringify(layout);
      if (next !== previous) {
        previous = next;
        void bridge?.setHostBrowserPanelLayout?.(layout).then((result) => {
          if (disposed || previous !== next) return;
          setSnapshot(visible && covered && typeof result === 'object' ? { browserId, layers: result.layers } : null);
        }).catch(() => {});
      }
      if (isVisible) frame = requestAnimationFrame(update);
    };
    update();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      void bridge?.setHostBrowserPanelLayout?.({ browserId, visible: false }).catch(() => {});
    };
  }, [browserId, isVisible]);

  useEffect(() => {
    if (!isVisible || opened.current) return;
    opened.current = true;
    setError(null);
    let cancelled = false;
    void mountHostBrowser({ ...optionsRef.current, browserId }).then(() => {
      if (mountedBrowserId.current === browserId) setReadyId(browserId);
    }).catch((reason: unknown) => {
      opened.current = false;
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [attempt, browserId, isVisible]);

  useEffect(() => {
    mountedBrowserId.current = browserId;
    return () => {
      opened.current = false;
      mountedBrowserId.current = null;
      // StrictMode replays setup immediately. Do not destroy its pending URL
      // or native browser unless the owning panel actually remains unmounted.
      queueMicrotask(() => {
        if (mountedBrowserId.current === browserId) return;
        void netcattyBridge.get()?.closeHostBrowserPanel?.(browserId).catch(() => {});
      });
    };
  }, [browserId]);

  return { elementRef, error, ready: readyId === browserId, snapshot: isVisible && snapshot?.browserId === browserId ? snapshot.layers : [],
    retry: () => setAttempt((value) => value + 1) };
}
