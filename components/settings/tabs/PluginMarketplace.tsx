import React, { useState } from 'react';
import { ArrowLeft, Package } from 'lucide-react';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { usePluginCatalog } from '../../../application/state/usePluginCatalog';
import { Button } from '../../ui/button';
import { PluginPackageDetails } from './PluginPackageManager';
import { PluginReadme } from './PluginReadme';

export function PluginMarketplace() {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string | null>(null);
  const catalog = usePluginCatalog(selected);
  const entry = catalog.entries.find((item) => item.id === selected);
  return <section className="space-y-4" aria-label={t('settings.plugins.market.title')}>
    <div><h3 className="font-medium">{t('settings.plugins.market.title')}</h3><p className="mt-1 text-xs text-muted-foreground">{t('settings.plugins.market.note')}</p></div>
    {catalog.error && <p role="alert" className="text-xs text-destructive">{catalog.error}</p>}
    {entry ? <article className="space-y-4 rounded-xl border border-border/70 p-5">
      <Button variant="ghost" size="sm" onClick={() => setSelected(null)}><ArrowLeft size={14} className="mr-2" />{t('settings.plugins.market.back')}</Button>
      <div><h4 className="text-lg font-semibold">{entry.name}</h4><p className="text-xs text-muted-foreground">{entry.author} · {entry.version} · {entry.license}</p></div>
      <p className="text-sm text-muted-foreground">{entry.description}</p>
      <a className="break-all text-xs underline" href={`https://github.com/${entry.repository}/tree/${entry.commit}`} target="_blank" rel="noopener noreferrer">{entry.repository} @ {entry.commit.slice(0, 12)}</a>
      <PluginPackageDetails plugin={{ id: entry.id, activeVersion: entry.version, enabled: false, manifest: entry.manifest, archiveSha256: entry.artifact?.sha256, runtime: { status: 'stopped', kind: null, lastError: null, quarantinedAt: null } }} />
      {entry.artifact ? <><p className="text-xs text-muted-foreground">{t('settings.plugins.market.installNote')}</p><Button disabled={catalog.busy} onClick={() => void catalog.install(entry.id)}>{t('settings.plugins.market.install')}</Button></> : <p className="rounded-lg bg-muted/40 p-3 text-xs">{t('settings.plugins.market.sourceOnly')}</p>}
      <div className="border-t border-border/60 pt-4"><h4 className="font-medium">README</h4><p className="text-xs text-muted-foreground">{t('settings.plugins.market.readmeNote')}</p>{catalog.readme !== null ? <PluginReadme markdown={catalog.readme} /> : <p className="mt-3 text-xs text-muted-foreground">{t('settings.plugins.loading')}</p>}</div>
    </article> : <div className="grid gap-3 sm:grid-cols-2">{catalog.entries.map((item) => <button key={item.id} type="button" onClick={() => setSelected(item.id)} className="space-y-2 rounded-xl border border-border/70 bg-background p-4 text-left transition-colors hover:bg-muted/30">
      <Package size={22} className="text-muted-foreground" /><div className="text-sm font-medium">{item.name}</div><p className="text-xs text-muted-foreground">{item.description}</p><p className="text-xs text-muted-foreground">{item.version} · {item.license}</p>
    </button>)}</div>}
  </section>;
}
