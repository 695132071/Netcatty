import React from 'react';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { Button } from '../../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../../ui/dialog';

/** Uses the existing renderer and host bridge; opening the manager never starts a plugin. */
export function PluginManagementDialog({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">{t('settings.plugins.openManager')}</Button>
      </DialogTrigger>
      <DialogContent className="flex h-[min(88dvh,900px)] w-[calc(100vw-2rem)] max-w-[1180px] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4 pr-12 text-left">
          <DialogTitle>{t('settings.plugins.title')}</DialogTitle>
        </DialogHeader>
        <div data-settings-scroll-pane className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
