import { useMemo } from 'react';
import { Blocks } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { activeTabStore } from '../../application/state/activeTabStore';
import { subscribeSidePanelLiveSnapshot } from '../../application/state/sidePanelLiveStore';
import { useEmbeddedPluginView } from '../../application/state/useEmbeddedPluginView';
import { usePluginContributions } from '../../application/state/usePluginContributions';
import { collectPluginTerminalSidebarPages, PLUGIN_TERMINAL_SIDEBAR_CONTEXT, requestOpenPluginTerminalSidebar,
  type PluginTerminalSidebarPage } from '../../application/state/usePluginTerminalSidebar';
import { PluginContributionIcon } from './PluginContributionIcon';
import { Button } from '../ui/button';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '../ui/popover';

export function PluginTerminalSidebarLauncher({ sessionId }: { sessionId: string }) {
  const { locale, t } = useI18n();
  const contributions = usePluginContributions({ locale, context: PLUGIN_TERMINAL_SIDEBAR_CONTEXT });
  const pages = collectPluginTerminalSidebarPages(contributions.snapshot.plugins);
  if (!pages.length) return null;
  return <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon" className="h-6 w-6" aria-label={t('plugins.sidebar.extensions')}><Blocks size={14} /></Button></PopoverTrigger>
    <PopoverContent align="end" className="max-h-80 w-64 overflow-y-auto p-1">
      <p className="px-2 py-1 text-xs text-muted-foreground">{t('plugins.sidebar.extensions')}</p>
      {pages.map((page) => <PopoverClose asChild key={page.tool}><button type="button" className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-accent"
        onClick={() => requestOpenPluginTerminalSidebar(page.viewId, sessionId)}>
        <PluginContributionIcon pluginId={page.pluginId} icon={page.icon} /><span className="min-w-0"><span className="block truncate">{page.title}</span><span className="block truncate text-xs text-muted-foreground">{page.pluginName}</span></span>
      </button></PopoverClose>)}
    </PopoverContent></Popover>;
}

export function PluginTerminalSidebarPageHost({ page, tabId, sessionId, adapter, getSession, unavailable, focused, focusOnReveal }: {
  page: PluginTerminalSidebarPage;
  tabId: string;
  sessionId: string;
  adapter: ReturnType<typeof usePluginContributions>;
  getSession(): string | null;
  unavailable(): void;
  focused(): void;
  focusOnReveal: boolean;
}) {
  const { t } = useI18n();
  const subscribeHidden = useMemo(() => (hide: () => void) => {
    const stopTab = activeTabStore.subscribeSync((id) => { if (id !== tabId) hide(); });
    const stopSession = subscribeSidePanelLiveSnapshot(true, () => { if (getSession() !== sessionId) hide(); });
    return () => { stopTab(); stopSession(); };
  }, [getSession, sessionId, tabId]);
  const { mountRef, loading } = useEmbeddedPluginView({ viewId: page.viewId, version: page.version,
    slot: `terminal-sidebar:${tabId}:${sessionId}`, active: true, context: PLUGIN_TERMINAL_SIDEBAR_CONTEXT,
    adapter, subscribeHidden, unavailable, focused, focusOnReveal });
  // The native page never receives these internal ownership IDs. Its state is
  // scoped by the host; this does not authorize reading the terminal session.
  return <section className="flex h-full min-h-0 flex-col overflow-hidden" aria-label={`${page.title} — ${page.pluginName}`} data-plugin-terminal-sidebar>
    <header className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-2 text-xs"><PluginContributionIcon pluginId={page.pluginId} icon={page.icon} size={12} /><span className="truncate">{page.title} · {page.pluginName}</span></header>
    <div ref={mountRef} className="relative min-h-0 flex-1 overflow-hidden" data-plugin-view-slot="terminal-sidebar">
      {loading && <p role="status" className="p-3 text-xs text-muted-foreground">{t('plugins.sidebar.loading')}</p>}
    </div>
  </section>;
}
