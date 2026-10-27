import { useEffect, useMemo, useState } from 'react';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

export function usePluginAuthorIdentity({ entry, plugin, sourceId = 'official' }: {
  entry?: NetcattyPluginCatalogEntry; plugin?: NetcattyInstalledPlugin; sourceId?: string;
}) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; value: NetcattyPluginAuthorPresentation } | null>(null);
  const pluginId = plugin?.id;
  const entryId = entry?.id;
  const selectionToken = entry?.selectionToken;
  const request = useMemo<NetcattyPluginAuthorRequest | null>(() => pluginId
    ? { kind: 'installed', pluginId }
    : entryId && selectionToken ? { kind: 'catalog', pluginId: entryId, selectionToken, sourceId } : null,
  [pluginId, entryId, selectionToken, sourceId]);
  const key = JSON.stringify([request, plugin?.activeVersion, plugin?.archiveSha256, plugin?.source?.id, plugin?.runtime?.quarantinedAt]);
  const installed = Boolean(plugin);
  const version = plugin?.activeVersion;
  const archiveSha256 = plugin?.archiveSha256 ?? null;
  const installedSourceId = plugin?.source?.id ?? 'local';
  useEffect(() => {
    if (!element || !request) return;
    let active = true;
    let started = false;
    const load = () => {
      if (started) return;
      started = true;
      void netcattyBridge.get()?.getPluginAuthorPresentation?.(request).then((value) => {
        if (!active || !value) return;
        if (installed && (value.version !== version || value.archiveSha256 !== archiveSha256 || value.sourceId !== installedSourceId)) return;
        setLoaded({ key, value });
      }).catch(() => { /* The visible author placeholder remains usable offline. */ });
    };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { load(); observer?.disconnect(); }
    }, { rootMargin: '64px' });
    if (observer) observer.observe(element); else load();
    return () => { active = false; observer?.disconnect(); };
  }, [element, request, key, installed, version, archiveSha256, installedSourceId]);
  return { ref: setElement, identity: loaded?.key === key ? loaded.value : null };
}
