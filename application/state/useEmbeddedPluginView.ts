import { useEffect, useRef, useState } from 'react';
import { PluginViewLifecycleController, type HostedPluginViewState } from './pluginViewLifecycle';
import { resolvePluginViewWindowScope } from './pluginViewScopes';
import { isPluginViewOccluded } from './pluginViewOcclusion';
import type { UsePluginContributionsResult } from './usePluginContributions';

type ViewAdapter = Pick<UsePluginContributionsResult, 'openView' | 'closeView' | 'setViewBounds' | 'setViewVisibility' | 'onViewClosed'>;

/** Host-owned mounting only. No plugin router, DOM, session or vault data API. */
export function useEmbeddedPluginView({ viewId, version, slot, active, context, adapter, subscribeHidden, unavailable }: {
  viewId: string;
  version: string;
  slot: string;
  active: boolean;
  context: Record<string, unknown>;
  adapter: ViewAdapter;
  subscribeHidden(listener: () => void): () => void;
  unavailable(): void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const adapterRef = useRef(adapter);
  const unavailableRef = useRef(unavailable);
  adapterRef.current = adapter;
  unavailableRef.current = unavailable;
  useEffect(() => {
    const mount = mountRef.current;
    if (!active || !mount) return;
    let cancelled = false;
    const lifecycle = new PluginViewLifecycleController<HostedPluginViewState>();
    const instanceId = crypto.randomUUID();
    const scopeId = resolvePluginViewWindowScope({ pathname: window.location.pathname,
      search: window.location.search, hash: `${window.location.hash}|plugin-slot:${slot}` });
    const { openView, closeView, setViewBounds, setViewVisibility, onViewClosed } = adapterRef.current;
    const close = () => {
      if (cancelled) return;
      cancelled = true;
      lifecycle.markViewClosed(viewId);
      void closeView(instanceId).catch(() => {});
    };
    const failCurrent = () => {
      if (cancelled) return;
      close();
      unavailableRef.current();
    };
    const unsubscribe = onViewClosed((event) => {
      lifecycle.handleHostClose(event.instanceId);
      if (event.instanceId === instanceId && !cancelled) {
        close();
        unavailableRef.current();
      }
    });
    const stopOnHide = subscribeHidden(close);
    const bounds = () => {
      const rect = mount.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
    };
    let opened = false;
    let visible = false;
    const updateVisibility = () => {
      if (!opened || cancelled) return;
      const rect = mount.getBoundingClientRect();
      const next = rect.width > 0 && rect.height > 0 && !isPluginViewOccluded(mount);
      if (visible === next) return;
      visible = next;
      void setViewVisibility(instanceId, next).catch(failCurrent);
    };
    const resize = () => {
      if (opened && !cancelled) void setViewBounds(instanceId, bounds()).catch(failCurrent);
      updateVisibility();
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(mount);
    const mutations = new MutationObserver(updateVisibility);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'inert', 'role', 'aria-modal', 'data-state', 'data-app-lock-overlay', 'data-native-view-occluder'] });
    window.addEventListener('resize', resize);
    document.addEventListener('scroll', resize, true);
    setLoading(true);
    const opening = lifecycle.beginOpen({ viewKey: viewId });
    void openView({ viewId, instanceId, scopeId, bounds: bounds(), context }).then(async (result) => {
      if (cancelled || lifecycle.shouldCloseOpen(opening) || lifecycle.consumeHostClose(result.instanceId)) {
        await closeView(result.instanceId);
        return;
      }
      opened = true;
      lifecycle.setCurrent({ id: result.instanceId, viewId, scopeId, retainContextWhenHidden: false });
      resize();
      setLoading(false);
    }).catch(() => {
      if (!cancelled) { close(); unavailableRef.current(); }
    }).finally(() => lifecycle.finishOpen({ token: opening, viewKey: viewId }));
    return () => {
      close(); unsubscribe(); stopOnHide(); observer?.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', resize); document.removeEventListener('scroll', resize, true);
    };
  }, [active, context, slot, subscribeHidden, version, viewId]);
  return { mountRef, loading };
}
