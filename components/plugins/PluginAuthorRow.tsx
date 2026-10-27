import React, { useState } from 'react';
import { UserRound } from 'lucide-react';
import { usePluginAuthorIdentity } from '../../application/state/usePluginAuthorIdentity';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Badge } from '../ui/badge';

export function PluginAuthorRow({ entry, plugin, sourceId }: {
  entry?: NetcattyPluginCatalogEntry; plugin?: NetcattyInstalledPlugin; sourceId?: string;
}) {
  const { t } = useI18n();
  const { ref, identity } = usePluginAuthorIdentity({ entry, plugin, sourceId });
  const [failed, setFailed] = useState<string | null>(null);
  const author = identity?.author ?? entry?.author ?? plugin?.manifest?.publisher ?? '';
  const imageKey = JSON.stringify([entry?.id, entry?.selectionToken, plugin?.id, plugin?.activeVersion, plugin?.archiveSha256, sourceId, identity?.avatar]);
  const avatar = identity?.avatar;
  const showImage = avatar && avatar.length <= 700_000 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar) && failed !== imageKey;
  return <div ref={ref} className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" data-plugin-author-row>
    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted/60" aria-hidden="true">
      {showImage ? <img src={avatar} alt="" width={20} height={20} className="h-full w-full object-cover" onError={() => setFailed(imageKey)} />
        : <UserRound size={13} data-plugin-author-placeholder />}
    </span>
    <span className="min-w-0 truncate" title={author}>{author}</span>
    {identity?.officialMaintained === true && <Badge className="shrink-0 whitespace-nowrap border-0 bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-800 hover:bg-amber-500/15 dark:bg-amber-400/15 dark:text-amber-300 dark:hover:bg-amber-400/15"
      title={t('settings.plugins.author.officialMeaning')} data-plugin-official-maintainer>{t('settings.plugins.author.official')}</Badge>}
  </div>;
}
