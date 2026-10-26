import React from 'react';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { Button } from '../../ui/button';
import { PluginInfo } from './PluginInfo';

export function PluginStatus({ noVault, offlineError, retry }: { noVault?: boolean; offlineError?: string | null; retry?: () => void }) {
  const { t } = useI18n();
  const count = Number(Boolean(noVault)) + Number(Boolean(offlineError));
  if (!count) return null;
  const explanation = <>{noVault && <p>{t('settings.plugins.manager.noVault')}</p>}{offlineError && <><p>{t('settings.plugins.market.offline')}</p><p className="break-words">{offlineError}</p></>}</>;
  const label = t('settings.plugins.status', { count });
  return <PluginInfo label={label} text={label} previewContent={explanation}>{explanation}{offlineError && retry && <Button variant="outline" size="sm" onClick={retry}>{t('settings.plugins.market.retry')}</Button>}</PluginInfo>;
}
