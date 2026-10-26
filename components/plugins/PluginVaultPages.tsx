import { activeTabStore } from '../../application/state/activeTabStore';
import { useI18n } from '../../application/i18n/I18nProvider';
import { useEmbeddedPluginView } from '../../application/state/useEmbeddedPluginView';
import type { usePluginVaultPages } from '../../application/state/usePluginVaultPages';
import { PluginContributionIcon } from './PluginContributionIcon';
import { Button } from '../ui/button';

type VaultPages = ReturnType<typeof usePluginVaultPages>;
const subscribeHidden = (hide: () => void) => activeTabStore.subscribeSync((id) => { if (id !== 'vault') hide(); });

export function PluginVaultNavigation({ model, collapsed }: { model: VaultPages; collapsed: boolean }) {
  const { t } = useI18n();
  if (!model.pages.length) return null;
  return <div role="group" aria-label={t('plugins.vault.extensions')} className="mt-3 space-y-1 border-t border-border/50 pt-3">
    {!collapsed && <p className="px-2 text-xs text-muted-foreground">{t('plugins.vault.extensions')}</p>}
    {model.pages.map((page) => <Button key={page.key} type="button"
      variant={model.selected?.key === page.key ? 'secondary' : 'ghost'}
      className={`w-full ${collapsed ? 'justify-center px-0' : 'justify-start gap-3'}`}
      title={`${page.title} — ${page.pluginName}`}
      aria-label={`${page.title} — ${page.pluginName}`}
      aria-current={model.selected?.key === page.key ? 'page' : undefined}
      onClick={() => model.select(page.key)}>
      <PluginContributionIcon pluginId={page.pluginId} icon={page.icon} className="shrink-0" />
      {!collapsed && <span className="truncate">{page.title}</span>}
    </Button>)}
  </div>;
}

export function PluginVaultPage({ model }: { model: VaultPages }) {
  const { t } = useI18n();
  const page = model.selected!;
  const { mountRef, loading } = useEmbeddedPluginView({ viewId: page.viewId, version: page.version, slot: 'vault-page',
    active: model.active, context: model.context, adapter: model.contributions, subscribeHidden, unavailable: model.fallback });
  return <section className="flex min-h-0 flex-1 flex-col" aria-label={page.title} data-plugin-vault-page={page.key}>
    <header className="app-no-drag flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
      <div className="min-w-0"><h2 className="truncate text-sm font-medium">{page.title}</h2>
        <p className="truncate text-xs text-muted-foreground">{page.pluginName} · {page.version}</p></div>
      <Button variant="ghost" onClick={model.fallback}>{t('plugins.vault.back')}</Button>
    </header>
    <div ref={mountRef} className="relative min-h-0 flex-1 overflow-hidden" data-plugin-view-slot="vault-page">
      {loading && <p role="status" className="p-4 text-sm text-muted-foreground">{t('plugins.vault.loading')}</p>}
    </div>
  </section>;
}
