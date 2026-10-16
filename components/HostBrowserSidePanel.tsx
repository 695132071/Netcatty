import React from 'react';
import { useHostBrowserPanel } from '../application/state/useHostBrowserPanel';
import { useI18n } from '../application/i18n/I18nProvider';

export function HostBrowserSidePanel(props: Parameters<typeof useHostBrowserPanel>[0]) {
  const { elementRef, error, retry } = useHostBrowserPanel(props);
  const { t } = useI18n();
  return (
    <div ref={elementRef} className="relative h-full min-h-0 w-full overflow-hidden" data-section="host-browser-panel" data-browser-host-id={props.host.id}>
      {error && <div className="p-4 text-sm text-muted-foreground">
        <p>{error}</p>
        <button type="button" className="mt-3 text-primary" onClick={retry}>{t('common.retry')}</button>
      </div>}
    </div>
  );
}
