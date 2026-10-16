import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { currentBrowserThemeTokens, mountHostBrowser } from '../hostBrowser';
import type { Host, Identity, KnownHost, SSHKey, TerminalSettings } from '../../domain/models';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

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
  const { browserId, isVisible } = options;

  useLayoutEffect(() => {
    const bridge = netcattyBridge.get();
    let frame = 0;
    let previous = '';
    const update = () => {
      const element = elementRef.current;
      const rect = element?.getBoundingClientRect();
      // Native page views must leave the screen with their owning pane and
      // must not cover a renderer dialog or a toolbar's open menu.
      const covered = !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"][data-state="open"], [data-radix-popper-content-wrapper]');
      const visible = isVisible && !!element?.isConnected && !!rect
        && rect.width > 0 && rect.height > 0 && !element?.closest('[inert]') && !covered;
      const bounds = rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined;
      const theme = element && getComputedStyle(element).colorScheme === 'light' ? 'light' : 'dark';
      const themeTokens = currentBrowserThemeTokens(element ?? undefined);
      const next = JSON.stringify({ browserId, visible, bounds, theme, themeTokens });
      if (next !== previous) {
        previous = next;
        void bridge?.setHostBrowserPanelLayout?.({ browserId, visible, bounds, theme, themeTokens }).catch(() => {});
      }
      if (isVisible) frame = requestAnimationFrame(update);
    };
    update();
    return () => {
      cancelAnimationFrame(frame);
      void bridge?.setHostBrowserPanelLayout?.({ browserId, visible: false }).catch(() => {});
    };
  }, [browserId, isVisible]);

  useEffect(() => {
    if (!isVisible || opened.current) return;
    opened.current = true;
    setError(null);
    let cancelled = false;
    void mountHostBrowser({ ...optionsRef.current, browserId }).catch((reason: unknown) => {
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

  return { elementRef, error, retry: () => setAttempt((value) => value + 1) };
}
