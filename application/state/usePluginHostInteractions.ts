import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostInteractionPrompt, HostInteractionResponse } from '@netcatty/plugin-contract';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

export function usePluginHostInteractions() {
  const [prompt, setPrompt] = useState<HostInteractionPrompt | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = useRef<HostInteractionPrompt | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onPluginInteraction || !bridge.setPluginInteractionReady) return;
    const unsubscribe = bridge.onPluginInteraction((event) => {
      if ('closed' in event) {
        if (current.current?.requestId !== event.requestId) return;
        current.current = null; setPrompt(null);
      } else {
        current.current = event; setPrompt(event);
        setValue(event.request.kind === 'input' ? event.request.initialValue ?? '' : '');
      }
      pending.current = false; setBusy(false); setError(false);
    });
    void bridge.setPluginInteractionReady(true).catch(() => {});
    return () => {
      current.current = null;
      unsubscribe();
      void bridge.setPluginInteractionReady?.(false).catch(() => {});
    };
  }, []);
  const respond = useCallback(async (action: HostInteractionResponse['action']) => {
    const active = current.current;
    if (!active || pending.current) return;
    pending.current = true; setBusy(true); setError(false);
    try {
      const bridge = netcattyBridge.require();
      if (!bridge.respondPluginInteraction) throw new Error('Host interactions unavailable');
      const accepted = await bridge.respondPluginInteraction({
        requestId: active.requestId, actionToken: active.actionToken, action,
        ...(action === 'submit' && (active.request.kind === 'input' || active.request.kind === 'quickPick') ? { value } : {}),
      });
      if (!accepted && current.current?.actionToken === active.actionToken) {
        current.current = null; setPrompt(null);
      }
    } catch {
      if (current.current?.actionToken === active.actionToken) setError(true);
    } finally {
      if (current.current?.actionToken === active.actionToken) { pending.current = false; setBusy(false); }
    }
  }, [value]);
  return { prompt, value, setValue, error, busy, respond };
}
