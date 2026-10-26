import React, { useState } from 'react';
import { Package, Upload } from 'lucide-react';
import { usePluginManager } from '../../../application/state/usePluginManager';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { Button } from '../../ui/button';

export function PluginPackageDetails({ plugin }: { plugin: NetcattyInstalledPlugin }) {
  const { t } = useI18n();
  const manifest = plugin.manifest;
  if (!manifest) return null;
  const permissions = [
    ...(manifest.permissions?.required ?? []).map((value) => ({ value, required: true })),
    ...(manifest.permissions?.optional ?? []).map((value) => ({ value, required: false })),
  ];
  const advanced = !manifest.main.browser || Boolean(manifest.companionExecutables?.length)
    || manifest.contributes?.providers?.some((p) => p.kind === 'terminal.interceptor.input' || p.kind === 'terminal.interceptor.output');
  return <div className="space-y-4 border-t border-border/60 pt-4 text-sm">
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
      <dt className="text-muted-foreground">ID</dt><dd className="break-all font-mono">{plugin.id}</dd>
      <dt className="text-muted-foreground">Netcatty</dt><dd>{manifest.engines.netcatty}</dd>
      <dt className="text-muted-foreground">API</dt><dd>{manifest.engines.api}</dd>
      <dt className="text-muted-foreground">SHA-256</dt><dd className="break-all font-mono">{plugin.archiveSha256 ?? '-'}</dd>
    </dl>
    <p className={advanced ? 'text-destructive' : 'text-muted-foreground'}>{t(advanced ? 'settings.plugins.manager.advanced' : 'settings.plugins.manager.browser')}</p>
    <div className="space-y-2">
      <h4 className="font-medium">{t('settings.plugins.manager.permissions')}</h4>
      <p className="text-xs text-muted-foreground">{t('settings.plugins.manager.permissionNote')}</p>
      {permissions.length === 0 && <p className="text-xs text-muted-foreground">{t('settings.plugins.manager.noPermissions')}</p>}
      {permissions.map(({ value, required }, index) => <div key={index} className="rounded-md bg-muted/40 p-3">
        <div className="flex justify-between gap-3"><code className="break-all text-xs">{typeof value === 'string' ? value : value.permission}</code><span className="text-xs text-muted-foreground">{t(required ? 'settings.plugins.manager.required' : 'settings.plugins.manager.optional')}</span></div>
        {['runtime.advanced', 'vault.credentials', 'secrets', 'terminal.output', 'terminal.input', 'terminal.intercept.input', 'terminal.intercept.output', 'filesystem.read', 'filesystem.write', 'network', 'companion.execute'].includes(typeof value === 'string' ? value : value.permission) && <p className="mt-1 text-xs font-medium text-destructive">{t('settings.plugins.manager.sensitive')}</p>}
        {typeof value !== 'string' && <><p className="mt-1 whitespace-pre-wrap break-all text-xs">{value.resources.join('\n')}</p>{value.reason && <p className="mt-1 text-xs text-muted-foreground">{value.reason}</p>}</>}
      </div>)}
    </div>
    <p className="text-xs text-muted-foreground">{t('settings.plugins.manager.data')}</p>
  </div>;
}

export function PluginPackageManager() {
  const { t, resolvedLocale } = useI18n();
  const manager = usePluginManager();
  const [selected, setSelected] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  if (!manager.available) return null;
  return <section className="space-y-4" aria-label={t('settings.plugins.manager.installed')}>
    <div className="flex items-center justify-between gap-3">
      <h3 className="font-medium">{t('settings.plugins.manager.installed')} <span className="text-muted-foreground">{manager.plugins.length}</span></h3>
      <Button variant="outline" size="sm" disabled={manager.busy} onClick={() => void manager.importPackage()}><Upload size={14} className="mr-2" />{t('settings.plugins.manager.import')}</Button>
    </div>
    <p className="text-xs text-muted-foreground">{t('settings.plugins.manager.preview')}</p>
    {manager.credentialStorageAvailable === false && <p role="status" className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">{t('settings.plugins.manager.noVault')}</p>}
    {manager.error && <p role="alert" className="text-sm text-destructive">{manager.error}</p>}
    {!manager.plugins.length && <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{t('settings.plugins.manager.empty')}</div>}
    {manager.plugins.map((plugin) => <article key={plugin.id} className="space-y-4 rounded-xl border border-border/70 bg-background p-4">
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-muted p-2"><Package size={20} /></div>
        <button type="button" className="min-w-0 flex-1 text-left" aria-expanded={selected === plugin.id} onClick={() => setSelected(selected === plugin.id ? null : plugin.id)}>
          <div className="truncate text-sm font-medium">{typeof plugin.manifest?.displayName === 'string' ? plugin.manifest.displayName : plugin.manifest?.displayName?.[resolvedLocale] ?? plugin.manifest?.displayName?.en ?? plugin.manifest?.name ?? plugin.id}</div>
          <div className="text-xs text-muted-foreground">{plugin.activeVersion} · {t(plugin.enabled ? 'settings.plugins.manager.enabled' : 'settings.plugins.manager.disabled')}</div>
        </button>
        <Button variant="outline" size="sm" disabled={manager.busy} onClick={() => void manager.setEnabled(plugin.id, !plugin.enabled)}>{t(plugin.enabled ? 'settings.plugins.manager.disable' : 'settings.plugins.manager.enable')}</Button>
      </div>
      {plugin.runtime.lastError && <p role="status" className="break-words text-xs text-destructive">{plugin.runtime.lastError}</p>}
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
