import React, { useCallback, useEffect, useRef, useState } from 'react';
import { netcattyBridge } from '../../../infrastructure/services/netcattyBridge';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { describePluginPermission } from '../../../domain/pluginPermissionDescriptions.cjs';
import { Button } from '../../ui/button';

/** Host UI only. Plugin views cannot query or mutate this security state. */
export function PluginPermissionPanel({ pluginId, onChanged }: {
  pluginId: string;
  onChanged: () => Promise<void>;
}) {
  const { t, resolvedLocale } = useI18n();
  const [snapshot, setSnapshot] = useState<NetcattyPluginPermissionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const refresh = useCallback(async (preserveError = false) => {
    const current = ++generation.current;
    if (!preserveError) setError(null);
    try {
      const bridge = netcattyBridge.require();
      if (!bridge.getPluginPermissions) throw new Error(t('settings.plugins.permissions.unavailable'));
      const result = await bridge.getPluginPermissions(pluginId);
      if (current === generation.current) setSnapshot(result);
    } catch (cause) {
      if (current === generation.current) {
        setSnapshot(null);
        const message = cause instanceof Error ? cause.message : String(cause);
        setError((previous) => preserveError && previous ? `${previous}\n${message}` : message);
      }
    }
  }, [pluginId, t]);
  useEffect(() => {
    const requestGeneration = generation;
    void refresh();
    return () => { requestGeneration.current++; };
  }, [refresh]);
  const revoke = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const bridge = netcattyBridge.require();
      if (!bridge.revokePluginPermissions) throw new Error(t('settings.plugins.permissions.unavailable'));
      await bridge.revokePluginPermissions(pluginId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      try { await onChanged(); }
      catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError((previous) => previous ? `${previous}\n${message}` : message);
      }
      await refresh(true);
      pending.current = false; setBusy(false);
    }
  };
  return <section data-host-security-surface="" className="space-y-3 border-t border-border/60 pt-4 text-sm" aria-label={t('settings.plugins.permissions.title')}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium">{t('settings.plugins.permissions.title')}</h4>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>{t('settings.plugins.permissions.refresh')}</Button>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {!snapshot && !error && <p role="status">{t('settings.plugins.permissions.loading')}</p>}
    {snapshot && <>
      {snapshot.grants.length === 0 && <p className="text-xs text-muted-foreground">{t('settings.plugins.permissions.empty')}</p>}
      {snapshot.grants.map((grant, index) => <div key={index} className="rounded-md bg-muted/40 p-3 text-xs">
        <p className="font-medium">{describePluginPermission(grant.permission, resolvedLocale).label}</p>
        <p className="whitespace-pre-wrap break-all font-mono">{grant.resource}</p>
        <p>{t(grant.matchesCurrentActivation ? 'settings.plugins.permissions.current' : 'settings.plugins.permissions.inactive')}</p>
        <p>{t(`settings.plugins.permissions.${grant.scope}`)}{grant.sessionId ? ` · ${grant.sessionId}` : ''}</p>
        <time dateTime={new Date(grant.grantedAt).toISOString()}>{new Date(grant.grantedAt).toLocaleString(resolvedLocale)}</time>
      </div>)}
      <details className="text-xs">
        <summary className="cursor-pointer">{t('settings.plugins.permissions.audit')}</summary>
        <ol className="mt-2 space-y-1">{snapshot.audit.map((entry, index) => <li key={index} className="break-words">
          <time dateTime={new Date(entry.createdAt).toISOString()}>{new Date(entry.createdAt).toLocaleString(resolvedLocale)}</time>{' · '}
          {entry.event}{entry.permission ? ` · ${entry.permission}` : ''}{entry.scope ? ` · ${entry.scope}` : ''}
        </li>)}</ol>
      </details>
      <p className="text-xs text-muted-foreground">{t('settings.plugins.permissions.revokeNote')}</p>
      <Button variant="destructive" size="sm" disabled={busy} onClick={() => void revoke()}>{t('settings.plugins.permissions.revoke')}</Button>
    </>}
  </section>;
}
