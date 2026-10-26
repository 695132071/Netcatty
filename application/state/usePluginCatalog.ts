import { useEffect, useRef, useState } from 'react';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

type ReadmeState = { id: string; token?: string; attempt: number; status: 'loading' | 'ready' | 'error'; text: string; error: string | null };
export function usePluginCatalog(selectedId: string | null) {
  const [entries, setEntries] = useState<NetcattyPluginCatalogEntry[]>([]);
  const [listStatus, setListStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [source, setSource] = useState<NetcattyPluginCatalogSnapshot['source']>('builtin');
  const [listError, setListError] = useState<string | null>(null);
  const [listAttempt, setListAttempt] = useState(0);
  const [readmeState, setReadmeState] = useState<ReadmeState | null>(null);
  const [readmeAttempt, setReadmeAttempt] = useState(0);
  const [installError, setInstallError] = useState<{ id: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const installing = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setListStatus('loading'); setListError(null);
    void (async () => {
      try {
        const bridge = netcattyBridge.get();
        if (!bridge?.listPluginCatalog) throw new Error('Catalog browsing unavailable');
        const list = await bridge.listPluginCatalog();
        if (active) { setEntries(list.entries); setSource(list.source); setListError(list.error); setListStatus('ready'); }
      } catch (cause) { if (active) { setListStatus('error'); setListError(String(cause)); } }
    })();
    return () => { active = false; };
  }, [listAttempt]);
  const selectionToken = entries.find((entry) => entry.id === selectedId)?.selectionToken;
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    const base = { id: selectedId, token: selectionToken, attempt: readmeAttempt, text: '', error: null };
    setReadmeState({ ...base, status: 'loading' });
    void (async () => {
      try {
        const bridge = netcattyBridge.get();
        if (!bridge?.getPluginCatalogReadme) throw new Error('README retrieval unavailable');
        const text = await bridge.getPluginCatalogReadme(selectedId, selectionToken);
        if (active) setReadmeState({ ...base, status: 'ready', text });
      } catch (cause) { if (active) setReadmeState({ ...base, status: 'error', error: String(cause) }); }
    })();
    return () => { active = false; };
  }, [selectedId, selectionToken, readmeAttempt]);
  const currentReadme = readmeState?.id === selectedId && readmeState.token === selectionToken && readmeState.attempt === readmeAttempt ? readmeState : null;
  return {
    entries, listStatus, listError, source,
    readme: currentReadme?.status === 'ready' ? currentReadme.text : null,
    readmeStatus: currentReadme?.status ?? (selectedId ? 'loading' : 'idle'),
    readmeError: currentReadme?.error ?? null,
    error: installError?.id === selectedId ? installError.message : null,
    busy,
    retryList: () => setListAttempt((attempt) => attempt + 1),
    retryReadme: () => setReadmeAttempt((attempt) => attempt + 1),
    async install(id: string) {
      if (installing.current) return;
      installing.current = true;
      setBusy(true); setInstallError(null);
      try {
        const bridge = netcattyBridge.require();
        if (!bridge.installCatalogPlugin) throw new Error('Catalog installation unavailable');
        await bridge.installCatalogPlugin(id, entries.find((entry) => entry.id === id)?.selectionToken);
        window.dispatchEvent(new Event('netcatty:plugin-packages-changed'));
      } catch (cause) { if (mounted.current) setInstallError({ id, message: String(cause) }); }
      finally { installing.current = false; if (mounted.current) setBusy(false); }
    },
  };
}
