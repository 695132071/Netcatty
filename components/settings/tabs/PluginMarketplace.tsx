import React, { useRef, useState } from 'react';
import { PluginBrandIcon } from '../../plugins/PluginBrandIcon';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { usePluginCatalog } from '../../../application/state/usePluginCatalog';
import { Input } from '../../ui/input';
import { Button } from '../../ui/button';
import { SettingCard } from '../settings-ui';
import { PluginPackageDetails } from './PluginPackageManager';
import { PluginReadme } from './PluginReadme';

export function PluginMarketplace({ installed = [] }: { installed?: NetcattyInstalledPlugin[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const catalog = usePluginCatalog(selected);
  return <PluginMarketplaceContent catalog={catalog} installed={installed} selected={selected} onSelect={setSelected} />;
}

// The browser owns only presentation state; installation and README policy stay in the existing hook.
export function PluginMarketplaceContent({ catalog, installed, selected, onSelect }: {
  catalog: ReturnType<typeof usePluginCatalog>;
  installed: NetcattyInstalledPlugin[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const lastSelection = useRef<string | null>(null);
  const listScroll = useRef(0);
  const pageScroll = useRef(0);
  const entry = catalog.entries.find((item) => item.id === selected);
  const filtered = filterPluginCatalog(catalog.entries, search);
  const installedEntry = installed.find((item) => item.id === entry?.id);
  const choose = (id: string) => {
    listScroll.current = listRef.current?.scrollTop ?? 0;
    if (!entry) pageScroll.current = listRef.current?.closest('[data-settings-scroll-pane]')?.scrollTop ?? 0;
    lastSelection.current = id;
    onSelect(id);
    requestAnimationFrame(() => {
      detailRef.current?.scrollTo?.(0, 0);
      const container = listRef.current?.closest<HTMLElement>('.plugin-marketplace');
      const pane = listRef.current?.closest('[data-settings-scroll-pane]');
      if (container && container.clientWidth < 820 && pane) pane.scrollTop = 0;
      detailRef.current?.focus({ preventScroll: true });
    });
  };
  const back = () => {
    onSelect(null);
    requestAnimationFrame(() => {
      if (listRef.current) {
        listRef.current.scrollTop = listScroll.current;
        const pane = listRef.current.closest('[data-settings-scroll-pane]');
        if (pane) pane.scrollTop = pageScroll.current;
        const button = Array.from(listRef.current.querySelectorAll<HTMLButtonElement>('[data-plugin-id]'))
          .find((item) => item.dataset.pluginId === lastSelection.current);
        button?.focus({ preventScroll: true });
      }
    });
  };
  return <section className="plugin-marketplace space-y-4" aria-label={t('settings.plugins.market.title')}>
    <p className="text-xs text-muted-foreground">{t('settings.plugins.market.note')}</p>
    {catalog.error && <p role="alert" className="text-xs text-destructive">{catalog.error}</p>}
    <div className={`plugin-marketplace-browser${entry ? ' plugin-marketplace-browser--selected' : ''}`}>
      <div className="plugin-marketplace-catalog space-y-3" ref={listRef}>
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('settings.plugins.market.search')} aria-label={t('settings.plugins.market.search')} />
        {catalog.listStatus === 'ready' && <p className="text-xs text-muted-foreground" aria-live="polite">{t('settings.plugins.market.results', { count: filtered.length })}</p>}
        {catalog.listStatus === 'ready' && catalog.entries.length > 0 && filtered.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t('settings.plugins.market.noResults')}</p>}
        {catalog.listStatus === 'loading' && <p className="text-xs text-muted-foreground">{t('settings.plugins.loading')}</p>}
        {catalog.listStatus === 'error' && <div role="alert" className="space-y-2 text-xs text-destructive"><p>{catalog.listError}</p><Button variant="outline" size="sm" onClick={catalog.retryList}>{t('settings.plugins.market.retry')}</Button></div>}
        {catalog.listStatus === 'ready' && catalog.entries.length === 0 && <p className="text-xs text-muted-foreground">{t('settings.plugins.market.empty')}</p>}
        <div className="plugin-marketplace-grid">{filtered.map((item) => {
          const isInstalled = installed.some((plugin) => plugin.id === item.id);
          return <button key={item.id} type="button" data-plugin-id={item.id} aria-current={selected === item.id ? 'true' : undefined} onClick={() => choose(item.id)}
            className={`min-w-0 flex flex-col gap-3 rounded-lg border p-4 text-left ${entry ? '' : 'min-h-[200px]'} transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected === item.id ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border bg-card hover:bg-muted/50'}`}>
            <div className="flex items-start gap-2"><PluginBrandIcon entry={item} size={32} className="mt-0.5 shrink-0 text-muted-foreground" /><span className="min-w-0 break-words text-sm font-semibold">{item.name}</span></div>
            <p className="break-words text-xs text-muted-foreground">{item.author}</p>
            <p className="line-clamp-3 break-words text-sm leading-5 text-muted-foreground">{item.description}</p>
            <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground"><span>{item.version} · {item.license}</span><span className="text-foreground">{t('settings.plugins.manager.details')}</span></div>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">{isInstalled && <span className="rounded bg-muted px-2 py-0.5 text-foreground">{t('settings.plugins.market.installed')}</span>}{!item.artifact && <span className="rounded border px-2 py-0.5">{t('settings.plugins.market.sourceBadge')}</span>}</div>
          </button>;
        })}</div>
      </div>
      {entry && <article key={entry.id} ref={detailRef} tabIndex={-1} aria-label={entry.name} className="plugin-marketplace-detail min-w-0 space-y-5 rounded-lg border bg-card p-4 focus:outline-none">
        <Button variant="ghost" size="sm" onClick={back}><ArrowLeft size={14} className="mr-2" />{t('settings.plugins.market.back')}</Button>
        <div className="space-y-2"><div className="flex items-center gap-3"><PluginBrandIcon entry={entry} size={48} /><h4 className="break-words text-xl font-semibold">{entry.name}</h4></div><p className="text-xs text-muted-foreground">{entry.author} · {entry.version} · {entry.license}</p>
          {installedEntry && <p className="text-xs text-muted-foreground">{t('settings.plugins.market.installed')} · {installedEntry.activeVersion} · {t(installedEntry.enabled ? 'settings.plugins.manager.enabled' : 'settings.plugins.manager.disabled')}</p>}
        </div>
        {installedEntry?.runtime?.lastError && <p role="status" className="break-words text-xs text-destructive">{t('settings.plugins.manager.lastError')}: {installedEntry.runtime.lastError}</p>}
        <p className="text-sm leading-6 text-muted-foreground">{entry.description}</p>
        <a className="block break-all text-xs text-primary underline underline-offset-4" href={`https://github.com/${entry.repository}/tree/${entry.commit}`} target="_blank" rel="noopener noreferrer">{entry.repository} @ {entry.commit.slice(0, 12)}</a>
        {entry.artifact ? <div className="space-y-2"><p className="text-xs text-muted-foreground">{t('settings.plugins.market.installNote')}</p><Button size="sm" disabled={catalog.busy} onClick={() => void catalog.install(entry.id)}>{t('settings.plugins.market.install')}</Button></div> : <p className="rounded-lg bg-muted/40 p-3 text-xs leading-5">{t('settings.plugins.market.sourceOnly')}</p>}
        <SettingCard padded><h4 className="mb-3 text-sm font-semibold">{t('settings.plugins.market.manifest')}</h4><PluginPackageDetails plugin={{ id: entry.id, activeVersion: entry.version, enabled: false, manifest: entry.manifest, archiveSha256: entry.artifact?.sha256, runtime: { status: 'stopped', kind: null, lastError: null, quarantinedAt: null } }} /></SettingCard>
        <div className="min-w-0 border-t pt-4"><h4 className="text-sm font-semibold">README</h4><p className="mt-2 text-xs text-muted-foreground">{t('settings.plugins.market.readmeNote')}</p>{catalog.readmeStatus === 'loading' && <p className="mt-3 text-xs text-muted-foreground">{t('settings.plugins.loading')}</p>}
          {catalog.readmeStatus === 'error' && <div role="alert" className="mt-3 space-y-2 text-xs text-destructive"><p>{catalog.readmeError}</p><Button variant="outline" size="sm" onClick={catalog.retryReadme}>{t('settings.plugins.market.retry')}</Button></div>}
          {catalog.readmeStatus === 'ready' && (catalog.readme?.trim() ? <PluginReadme markdown={catalog.readme} /> : <p className="mt-3 text-xs text-muted-foreground">{t('settings.plugins.market.emptyReadme')}</p>)}
        </div>
      </article>}
    </div>
  </section>;
}

export function filterPluginCatalog(entries: NetcattyPluginCatalogEntry[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter((entry) => `${entry.name} ${entry.author} ${entry.description}`.toLocaleLowerCase().includes(needle));
}
