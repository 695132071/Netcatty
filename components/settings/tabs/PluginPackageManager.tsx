import { describePluginPermission } from '@/domain/pluginPermissionDescriptions.cjs';
import { describePluginRuntime } from '@/domain/pluginRuntimePolicy.cjs';
import React, { useState } from 'react';
import { ArrowLeft, Package } from 'lucide-react';
import { usePluginManager } from '../../../application/state/usePluginManager';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { Button } from '../../ui/button';

export function PluginPackageDetails({ plugin }: { plugin: NetcattyInstalledPlugin }) {
  const { t, resolvedLocale } = useI18n();
  const manifest = plugin.manifest;
  if (!manifest) return null;
  const permissions = [
    ...(manifest.permissions?.required ?? []).map((value) => ({ value, required: true })),
    ...(manifest.permissions?.optional ?? []).map((value) => ({ value, required: false })),
  ];
  const policy = describePluginRuntime(manifest);
  const runtimeKind = plugin.runtime.kind ?? policy.defaultRuntimeKind;
  const runtimeLabel = runtimeKind === 'utility' ? 'advanced'
    : policy.hasNode ? 'dual' : policy.declaresAdvanced ? 'advancedDeclaration' : 'browser';
  return <div className="space-y-4 border-t border-border/60 pt-4 text-sm">
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
      <dt className="text-muted-foreground">ID</dt><dd className="break-all font-mono">{plugin.id}</dd>
      <dt className="text-muted-foreground">Netcatty</dt><dd>{manifest.engines.netcatty}</dd>
      <dt className="text-muted-foreground">API</dt><dd>{manifest.engines.api}</dd>
      <dt className="text-muted-foreground">SHA-256</dt><dd className="break-all font-mono">{plugin.archiveSha256 ?? '-'}</dd>
    </dl>
    <p className={!policy.browserOnly ? 'text-destructive' : 'text-muted-foreground'}>{t(`settings.plugins.manager.${runtimeLabel}`)}</p>
    <div className="space-y-2">
      <h4 className="font-medium">{t('settings.plugins.manager.permissions')}</h4>
      <p className="text-xs text-muted-foreground">{t('settings.plugins.manager.permissionNote')}</p>
      {permissions.length === 0 && <p className="text-xs text-muted-foreground">{t('settings.plugins.manager.noPermissions')}</p>}
      {permissions.map(({ value, required }, index) => {
        const id = typeof value === 'string' ? value : value.permission;
        const description = describePluginPermission(id, resolvedLocale);
        return <div key={index} className="rounded-md bg-muted/40 p-3">
        <div className="flex justify-between gap-3"><span className="text-sm font-medium">{description.label}</span><span className="text-xs text-muted-foreground">{t(required ? 'settings.plugins.manager.required' : 'settings.plugins.manager.optional')}</span></div>
        <p className="mt-1 text-xs text-muted-foreground">{description.description}</p>
        <code className="mt-1 block break-all text-[10px] text-muted-foreground">{id}</code>
        {description.sensitive && <p className="mt-1 text-xs font-medium text-destructive">{t('settings.plugins.manager.sensitive')}</p>}
        {(typeof value === 'string' || value.resources.length === 0) && <p className="mt-1 text-xs">{t('settings.plugins.manager.unbounded')}</p>}
        {typeof value !== 'string' && <><p className="mt-1 whitespace-pre-wrap break-all text-xs">{value.resources.join('\n')}</p>{value.reason && <p className="mt-1 text-xs text-muted-foreground">{value.reason}</p>}</>}
      </div>; })}
    </div>
    <p className="text-xs text-muted-foreground">{t('settings.plugins.manager.data')}</p>
  </div>;
}

export function PluginPackageManager({ manager }: { manager: ReturnType<typeof usePluginManager> }) {
  const { t, resolvedLocale } = useI18n();
  const [selected, setSelected] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  if (!manager.available) return null;
  return <section className="space-y-4" aria-label={t('settings.plugins.manager.installed')}>
    <p className="text-xs text-muted-foreground">{t('settings.plugins.manager.preview')}</p>
    {selected && <Button variant="ghost" size="sm" onClick={() => { setSelected(null); setRemoving(null); }}><ArrowLeft size={14} className="mr-2" />{t('settings.plugins.manager.installed')}</Button>}
    {manager.error && <p role="alert" className="text-sm text-destructive">{manager.error}</p>}
    {!manager.plugins.length && <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{t('settings.plugins.manager.empty')}</div>}
    {manager.plugins.filter((plugin) => !selected || plugin.id === selected).map((plugin) => <article key={plugin.id} className="space-y-4 rounded-xl border border-border/70 bg-background p-4">
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-muted p-2"><Package size={20} /></div>
        <button type="button" className="min-w-0 flex-1 text-left" aria-expanded={selected === plugin.id} onClick={() => setSelected(selected === plugin.id ? null : plugin.id)}>
          <div className="truncate text-sm font-medium">{typeof plugin.manifest?.displayName === 'string' ? plugin.manifest.displayName : plugin.manifest?.displayName?.[resolvedLocale] ?? plugin.manifest?.displayName?.en ?? plugin.manifest?.name ?? plugin.id}</div>
          <div className="text-xs text-muted-foreground">{plugin.manifest?.publisher} · {plugin.activeVersion} · {t(plugin.enabled ? 'settings.plugins.manager.enabled' : 'settings.plugins.manager.disabled')}</div>
        </button>
        <Button variant="outline" size="sm" disabled={manager.busy} onClick={() => void manager.setEnabled(plugin.id, !plugin.enabled)}>{t(plugin.enabled ? 'settings.plugins.manager.disable' : 'settings.plugins.manager.enable')}</Button>
      </div>
      {plugin.runtime.lastError && <p role="status" className="break-words text-xs text-destructive">{t('settings.plugins.manager.lastError')}: {plugin.runtime.lastError}</p>}
      {selected === plugin.id && <>
        <PluginPackageDetails plugin={plugin} />
        {removing === plugin.id ? <div className="space-y-2 rounded-lg border border-destructive/30 p-3">
          <p className="text-xs">{t('settings.plugins.manager.removeNote')}</p>
          <Button variant="destructive" size="sm" disabled={manager.busy} onClick={() => { void manager.uninstall(plugin.id); setRemoving(null); }}>{t('settings.plugins.manager.remove')}</Button>
          <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
        </div> : <Button variant="ghost" size="sm" disabled={manager.busy} onClick={() => setRemoving(plugin.id)}>{t('settings.plugins.manager.remove')}</Button>}
      </>}
    </article>)}
  </section>;
}
