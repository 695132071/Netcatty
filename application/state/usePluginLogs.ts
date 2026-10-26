import { useCallback, useEffect, useRef, useState } from 'react';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

export function usePluginLogs() {
  const [status, setStatus] = useState<NetcattyPluginLogStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const run = useCallback(async (action: 'status' | 'configure' | 'open' | 'export' | 'clear', settings?: { saveToDisk: boolean; verbose: boolean }) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const bridge = netcattyBridge.require();
      const result = await (action === 'configure' ? bridge.configurePluginLogs?.(settings!)
        : action === 'open' ? bridge.openPluginLogFolder?.()
          : action === 'export' ? bridge.exportPluginLogs?.()
            : action === 'clear' ? bridge.clearPluginLogs?.() : bridge.getPluginLogStatus?.());
      if (!result) throw new Error('Local plugin logging is unavailable');
      if (mounted.current) setStatus(result);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void run('status');
    return () => { mounted.current = false; };
  }, [run]);
  return { status, error, busy, run };
}
