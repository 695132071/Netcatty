import React, { useCallback, useMemo, useState } from 'react';
import { RefreshCw, Settings2 } from 'lucide-react';
import { useI18n } from '../../../application/i18n/I18nProvider';
import type { usePluginManager } from '../../../application/state/usePluginManager';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { PluginBrandIcon } from '../../plugins/PluginBrandIcon';
import { SettingCard, SettingRow, SettingsSection, Toggle } from '../settings-ui';
import { PluginLogSettings } from './PluginLogSettings';

type Manager = ReturnType<typeof usePluginManager>;

export function PluginSettingsLanding({ manager, settingsAvailable, settingsError, managerButtonRef, onManage }: {
  manager: Manager;
  settingsAvailable: ReadonlySet<string>;
  settingsError?: string;
  managerButtonRef?: React.Ref<HTMLButtonElement>;
  onManage: (pluginId: string | null, opener: HTMLElement) => void;
}) {
  const { t, resolvedLocale } = useI18n();
  const [search, setSearch] = useState('');
  const localized = useCallback((value: string | Record<string, string> | undefined) => typeof value === 'string' ? value : value?.[resolvedLocale] ?? value?.en ?? '', [resolvedLocale]);
  const nameOf = (plugin: NetcattyInstalledPlugin) => localized(plugin.manifest?.displayName) || plugin.manifest?.name || plugin.id;
  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return manager.plugins.filter((plugin) => [localized(plugin.manifest?.displayName), plugin.manifest?.name, plugin.id, plugin.manifest?.publisher, localized(plugin.manifest?.description), plugin.source?.name].some((value) => String(value ?? '').toLocaleLowerCase().includes(term)));
  }, [manager.plugins, search, localized]);
  const statusOf = (plugin: NetcattyInstalledPlugin) => {
    if (!manager.statusKnown) return t('settings.plugins.permissions.statusUnknown');
    const state = plugin.runtime.status;
    if (['running', 'starting', 'stopping', 'error', 'quarantined'].includes(state)) return t(`settings.plugins.landing.status.${state}`);
    if (state !== 'stopped') return t('settings.plugins.landing.status.unknown');
    return t(plugin.enabled ? 'settings.plugins.landing.status.idle' : 'settings.plugins.manager.disabled');
  };
  const sourceOf = (plugin: NetcattyInstalledPlugin) => {
    const source = plugin.source;
    if (!source) return t('settings.plugins.landing.sourceUnknown');
    const kind = t(source.kind === 'official' ? 'settings.plugins.sources.official' : source.kind === 'third-party' ? 'settings.plugins.sources.thirdparty' : 'settings.plugins.sources.local');
    return `${t('settings.plugins.sources.source')}: ${kind}${source.kind === 'third-party' ? ` · ${source.name}` : ''}`;
  };
  return <>
    <SettingsSection title={t('settings.plugins.landing.options')}>
      <SettingCard divided>
        <SettingRow label={t('settings.plugins.landing.manager')} description={t('settings.plugins.landing.managerDescription')}>
          <Button ref={managerButtonRef} variant="outline" size="sm" onClick={(event) => onManage(null, event.currentTarget)}>{t('settings.plugins.landing.browse')}</Button>
        </SettingRow>
        <PluginLogSettings />
      </SettingCard>
    </SettingsSection>
    <SettingsSection title={`${t('settings.plugins.manager.installed')} · ${manager.plugins.length}`} actions={
      <Button variant="ghost" size="icon" disabled={manager.busy} aria-label={t('settings.plugins.landing.refresh')} onClick={() => void manager.refresh().catch(() => {})}><RefreshCw size={16} /></Button>
    }>
      {settingsError && <p role="alert" className="text-sm text-destructive">{settingsError}</p>}
      {manager.error && <p role="alert" className="text-sm text-destructive">{manager.error}</p>}
      {!manager.statusKnown && !manager.error && <p role="status" className="text-sm text-muted-foreground">{t('settings.plugins.landing.loading')}</p>}
      {manager.statusKnown && !manager.available && <p role="status" className="text-sm text-muted-foreground">{t('settings.plugins.landing.unavailable')}</p>}
      {manager.statusKnown && manager.available && manager.plugins.length === 0 && <p className="text-sm text-muted-foreground">{t('settings.plugins.landing.empty')}</p>}
      {manager.plugins.length > 0 && <>
        <Input aria-label={t('settings.plugins.landing.search')} placeholder={t('settings.plugins.landing.search')} value={search} onChange={(event) => setSearch(event.target.value)} />
        {visible.length === 0 ? <p role="status" className="text-sm text-muted-foreground">{t('settings.plugins.market.noResults')}</p> : <SettingCard divided>
          {visible.map((plugin) => {
            const name = nameOf(plugin);
            const description = localized(plugin.manifest?.description);
            const declaredSettings = Boolean(plugin.manifest?.contributes?.settings?.length || plugin.manifest?.contributes?.views?.some((view) => view.location === 'settings'));
            return <SettingRow key={plugin.id} leading={<PluginBrandIcon plugin={plugin} size={24} />} label={<span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate" title={name}>{name}</span>
              {plugin.activeVersion && <span className="shrink-0 text-xs font-normal text-muted-foreground">{plugin.activeVersion}</span>}
            </span>} description={<>
              <span className="block break-words">{[plugin.manifest?.publisher, sourceOf(plugin), statusOf(plugin)].filter(Boolean).join(' · ')}</span>
              {description && <span className="line-clamp-2 break-words">{description}</span>}
            </>}>
              <div className="flex items-center gap-3">
                {declaredSettings && <Button variant="ghost" size="icon" disabled={manager.busy || !manager.statusKnown || !settingsAvailable.has(plugin.id)} aria-label={t('settings.plugins.landing.settingsFor').replace('{name}', name)} title={t(settingsAvailable.has(plugin.id) ? 'common.settings' : !plugin.enabled ? 'settings.plugins.landing.enableSettings' : 'settings.plugins.landing.settingsUnavailable')} onClick={(event) => onManage(plugin.id, event.currentTarget)}><Settings2 size={16} /></Button>}
                <Toggle checked={plugin.enabled} disabled={manager.busy || !manager.available || !manager.statusKnown} ariaLabel={`${t(plugin.enabled ? 'settings.plugins.manager.disable' : 'settings.plugins.manager.enable')} ${name}`} onChange={(enabled) => void manager.setEnabled(plugin.id, enabled)} />
              </div>
            </SettingRow>;
          })}
        </SettingCard>}
      </>}
    </SettingsSection>
  </>;
}
