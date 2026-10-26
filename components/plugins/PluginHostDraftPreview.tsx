import { useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { applyPluginHostEdit, normalizePluginHostDraft, pluginHostFieldDiff, PLUGIN_HOST_CREATE_FIELDS, PLUGIN_HOST_EDIT_FIELDS, type PluginHostDraftFields } from '../../domain/pluginHostActions';
import type { Host } from '../../domain/models';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

/** Host-owned editable draft and exact normalized field diff. The containing
 * dialog owns confirmation, expiry and cancellation; this body has no IPC. */
export function PluginHostDraftPreview({ before, draft, busy, onConfirm }: {
  before?: Host;
  draft: PluginHostDraftFields;
  busy: boolean;
  onConfirm: (draft: PluginHostDraftFields) => void;
}) {
  const { t } = useI18n();
  const [fields, setFields] = useState<Record<string, string>>(() => ({
    label: draft.label ?? before?.label ?? '',
    hostname: draft.hostname ?? '', username: draft.username ?? '',
    port: String(draft.port ?? 22), group: draft.group ?? before?.group ?? '',
    tags: (draft.tags ?? before?.tags ?? []).join(', '),
  }));
  const preview = useMemo(() => {
    const value = {
      label: fields.label, group: fields.group,
      tags: fields.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      ...(!before ? { hostname: fields.hostname, username: fields.username, port: Number(fields.port) } : {}),
    };
    try {
      const after = before ? applyPluginHostEdit(before, value) : normalizePluginHostDraft(value, 'preview');
      return { value, diff: pluginHostFieldDiff(before, after) };
    } catch { return null; }
  }, [before, fields]);
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3">
      {(before ? PLUGIN_HOST_EDIT_FIELDS : PLUGIN_HOST_CREATE_FIELDS).map((field) => <label key={field} className="space-y-1 text-sm">
        <span>{t(`hostForm.field.${field}`)}</span>
        <Input value={fields[field]} type={field === 'port' ? 'number' : 'text'} min={field === 'port' ? 1 : undefined} max={field === 'port' ? 65535 : undefined} maxLength={field === 'tags' ? 32_896 : 1024} autoComplete="off" disabled={busy} onChange={(event) => setFields((previous) => ({ ...previous, [field]: event.target.value }))} />
      </label>)}
    </div>
    <p className="text-xs text-muted-foreground">{t('plugins.hostActions.defaultsWarning')}</p>
    {preview ? <div className="max-h-48 overflow-auto rounded-md border p-3">
      <p className="mb-2 text-sm font-medium">{t('plugins.hostActions.fieldDiff')}</p>
      <dl className="space-y-2 text-xs">
        {preview.diff.map((change) => <div key={change.field} className="break-all">
          <dt className="font-medium">{t(`hostForm.field.${change.field}`)}</dt>
          <dd>{JSON.stringify(change.before)} &rarr; {JSON.stringify(change.after)}</dd>
        </div>)}
      </dl>
    </div> : <p role="alert" className="text-sm text-destructive">{t('plugins.hostActions.invalidDraft')}</p>}
    <Button className="w-full" disabled={busy || !preview || preview.diff.length === 0} onClick={() => { if (preview) onConfirm(preview.value); }}>{t('hostForm.saveHost')}</Button>
  </div>;
}
