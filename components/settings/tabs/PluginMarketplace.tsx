import React, { useState } from 'react';
import { ArrowLeft, Package } from 'lucide-react';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { usePluginCatalog } from '../../../application/state/usePluginCatalog';
import { Input } from '../../ui/input';
import { Button } from '../../ui/button';
import { PluginPackageDetails } from './PluginPackageManager';
import { PluginReadme } from './PluginReadme';

export function PluginMarketplace() {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const catalog = usePluginCatalog(selected);
  const entry = catalog.entries.find((item) => item.id === selected);
  const filtered = filterPluginCatalog(catalog.entries, search);
  return <section className="space-y-4" aria-label={t('settings.plugins.market.title')}>
    <p className="text-xs text-muted-foreground">{t('settings.plugins.market.note')}</p>
    {!entry && <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('settings.plugins.market.search')} aria-label={t('settings.plugins.market.search')} />}
    {!entry && catalog.listStatus === 'ready' && catalog.entries.length > 0 && filtered.length === 0 && <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{t('settings.plugins.market.noResults')}</p>}
    {catalog.listStatus === 'loading' && <p className="text-xs text-muted-foreground">{t('settings.plugins.loading')}</p>}
    {catalog.listStatus === 'error' && <div role="alert" className="space-y-2 text-xs text-destructive"><p>{catalog.listError}</p><Button variant="outline" size="sm" onClick={catalog.retryList}>{t('settings.plugins.market.retry')}</Button></div>}
    {catalog.listStatus === 'ready' && catalog.entries.length === 0 && <p className="text-xs text-muted-foreground">{t('settings.plugins.market.empty')}</p>}
    {catalog.error && <p role="alert" className="text-xs text-destructive">{catalog.error}</p>}
    {entry ? <article className="space-y-5">
      <Button variant="ghost" size="sm" onClick={() => setSelected(null)}><ArrowLeft size={14} className="mr-2" />{t('settings.plugins.market.back')}</Button>
      <div><h4 className="text-lg font-semibold">{entry.name}</h4><p className="text-xs text-muted-foreground">{entry.author} · {entry.version} · {entry.license}</p></div>
      <p className="text-sm text-muted-foreground">{entry.description}</p>
      <a className="break-all text-xs underline" href={`https://github.com/${entry.repository}/tree/${entry.commit}`} target="_blank" rel="noopener noreferrer">{entry.repository} @ {entry.commit.slice(0, 12)}</a>
      <details className="rounded-xl border border-border/70 p-4"><summary className="cursor-pointer text-sm font-medium">{t('settings.plugins.market.manifest')}</summary><div className="mt-3"><PluginPackageDetails plugin={{ id: entry.id, activeVersion: entry.version, enabled: false, manifest: entry.manifest, archiveSha256: entry.artifact?.sha256, runtime: { status: 'stopped', kind: null, lastError: null, quarantinedAt: null } }} /></div></details>
      {entry.artifact ? <><p className="text-xs text-muted-foreground">{t('settings.plugins.market.installNote')}</p><Button disabled={catalog.busy} onClick={() => void catalog.install(entry.id)}>{t('settings.plugins.market.install')}</Button></> : <p className="rounded-lg bg-muted/40 p-3 text-xs">{t('settings.plugins.market.sourceOnly')}</p>}
      <div className="border-t border-border/60 pt-4"><h4 className="font-medium">README</h4><p className="text-xs text-muted-foreground">{t('settings.plugins.market.readmeNote')}</p>{catalog.readmeStatus === 'loading' && <p className="mt-3 text-xs text-muted-foreground">{t('settings.plugins.loading')}</p>}
        {catalog.readmeStatus === 'error' && <div role="alert" className="mt-3 space-y-2 text-xs text-destructive"><p>{catalog.readmeError}</p><Button variant="outline" size="sm" onClick={catalog.retryReadme}>{t('settings.plugins.market.retry')}</Button></div>}
        {catalog.readmeStatus === 'ready' && (catalog.readme?.trim() ? <PluginReadme markdown={catalog.readme} /> : <p className="mt-3 text-xs text-muted-foreground">{t('settings.plugins.market.emptyReadme')}</p>)}</div>
    </article> : <div className="grid gap-3 sm:grid-cols-2">{filtered.map((item) => <button key={item.id} type="button" onClick={() => setSelected(item.id)} className="space-y-2 rounded-xl border border-border/70 bg-background p-4 text-left transition-colors hover:bg-muted/30">
      <Package size={22} className="text-muted-foreground" /><div className="text-sm font-medium">{item.name}</div><p className="text-xs text-muted-foreground">{item.description}</p><p className="text-xs text-muted-foreground">{item.author} · {item.version} · {item.license}</p>
    </button>)}</div>}
  </section>;
}

export function filterPluginCatalog(entries: NetcattyPluginCatalogEntry[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter((entry) => `${entry.name} ${entry.author} ${entry.description}`.toLocaleLowerCase().includes(needle));
}
