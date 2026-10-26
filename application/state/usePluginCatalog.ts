import { useEffect, useState } from 'react';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

export function usePluginCatalog(selectedId: string | null) {
  const [entries, setEntries] = useState<NetcattyPluginCatalogEntry[]>([]);
  const [readme, setReadme] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void netcattyBridge.get()?.listPluginCatalog?.().then((list) => { if (active) setEntries(list); }).catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    void netcattyBridge.get()?.getPluginCatalogReadme?.(selectedId).then((text) => {
      if (active) setReadme({ id: selectedId, text });
    }).catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [selectedId]);
  return {
    entries, readme: readme?.id === selectedId ? readme.text : null, error, busy,
    async install(id: string) {
      if (busy) return;
      setBusy(true); setError(null);
      try {
        const bridge = netcattyBridge.require();
        if (!bridge.installCatalogPlugin) throw new Error('Catalog installation unavailable');
        await bridge.installCatalogPlugin(id);
        window.dispatchEvent(new Event('netcatty:plugin-packages-changed')); 
      } catch (cause) { setError(String(cause)); }
      finally { setBusy(false); }
    },
  };
}
