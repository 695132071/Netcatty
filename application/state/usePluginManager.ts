import { useCallback, useEffect, useRef, useState } from 'react';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

export function usePluginManager() {
  const [plugins, setPlugins] = useState<NetcattyInstalledPlugin[]>([]);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const mutation = useRef(false);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const bridge = netcattyBridge.get();
    const status = await bridge?.getPluginRuntimeStatus?.();
    const list = status?.available ? await bridge?.listPlugins?.() ?? [] : [];
    if (current !== generation.current) return;
    setAvailable(status?.available === true);
    setPlugins(list);
  }, []);
  useEffect(() => {
    const update = () => { void refresh().catch((cause) => setError(String(cause))); };
    update();
    const unsubscribe = netcattyBridge.get()?.onPluginContributionsChanged?.(update);
    const refreshGeneration = generation;
    return () => { refreshGeneration.current++; unsubscribe?.(); };
  }, [refresh]);
  const run = useCallback(async (action: (bridge: NetcattyBridge) => Promise<unknown>) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError(null);
    try { await action(netcattyBridge.require()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      try { await refresh(); } catch (cause) { setError(String(cause)); }
      mutation.current = false;
      setBusy(false);
    }
  }, [refresh]);
  return {
    plugins, available, busy, error,
    importPackage: () => run(async (bridge) => {
      if (!bridge.selectFile || !bridge.installPluginPackage) throw new Error('Plugin import unavailable');
      const path = await bridge.selectFile('Import plugin package', undefined, [{ name: 'Netcatty plugin', extensions: ['ncpkg'] }]);
      if (path) await bridge.installPluginPackage(path, { enable: false });
    }),
    setEnabled: (id: string, enabled: boolean) => run(async (bridge) => {
      if (!bridge.setPluginEnabled) throw new Error('Plugin management unavailable');
      return bridge.setPluginEnabled(id, enabled);
    }),
    uninstall: (id: string) => run(async (bridge) => {
      if (!bridge.uninstallPlugin) throw new Error('Plugin management unavailable');
      return bridge.uninstallPlugin(id);
    }),
  };
}
