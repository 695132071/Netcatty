import React, { useState } from 'react';
import { usePluginLogs } from '../../../application/state/usePluginLogs';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';

/** Embed in the existing plugin settings surface, without a new marketplace tab. */
export function PluginLogSettings() {
  const { resolvedLocale } = useI18n();
  const zh = resolvedLocale.startsWith('zh');
  const { status, error, busy, run } = usePluginLogs();
  const [confirmVerbose, setConfirmVerbose] = useState(false);
  const disclosure = zh
    ? '插件编写的日志文字可能包含敏感数据。截断和字段过滤不能保证任意文字安全。只为排查问题临时开启，导出前请检查。重启应用后自动关闭详细日志。'
    : 'Plugin-authored text may contain sensitive data. Truncation and field filtering cannot make arbitrary text safe. Enable temporarily for troubleshooting and review files before sharing. Verbose diagnostics turn off after app restart.';
  return <section data-host-security-surface="" className="space-y-3 rounded-lg border border-border/70 p-4 text-sm" aria-label={zh ? '本地插件日志' : 'Local plugin logs'}>
    <h4 className="font-medium">{zh ? '本地插件日志' : 'Local plugin logs'}</h4>
    <p className="text-xs text-muted-foreground">{zh ? '默认不保存。仅保存在此设备，不上传或同步。权限面板中的有限安全历史独立保留。' : 'Saving is off by default. Files stay on this device with no upload or sync. The bounded security history in plugin permissions is separate.'}</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <label className="flex items-center gap-2"><input type="checkbox" checked={status?.saveToDisk ?? false} disabled={busy || !status} onChange={(event) => void run('configure', { saveToDisk: event.target.checked, verbose: false })} />{zh ? '将宿主审计日志保存到本地' : 'Save host audit logs locally'}</label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={status?.verbose ?? false} disabled={busy || !status?.saveToDisk} onChange={(event) => event.target.checked ? setConfirmVerbose(true) : void run('configure', { saveToDisk: true, verbose: false })} />{zh ? '包含插件详细诊断文字（可能含敏感数据）' : 'Include verbose plugin text (may contain sensitive data)'}</label>
    {status && <p className="text-xs text-muted-foreground">{zh ? `最多 ${status.maxBytes / 1048576} MiB，保留 ${status.retentionDays} 天。丢弃 ${status.droppedRecords} 条，写入错误 ${status.writeErrors} 次。` : `Up to ${status.maxBytes / 1048576} MiB, retained for ${status.retentionDays} days. Dropped: ${status.droppedRecords}. Write errors: ${status.writeErrors}.`}</p>}
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={busy || !status} onClick={() => void run('open')}>{zh ? '打开文件夹' : 'Open folder'}</Button>
      <Button variant="outline" size="sm" disabled={busy || !status} onClick={() => void run('export')}>{zh ? '导出' : 'Export'}</Button>
      <Button variant="ghost" size="sm" disabled={busy || !status} onClick={() => void run('clear')}>{zh ? '清除日志…' : 'Clear logs…'}</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run('status')}>{zh ? '刷新' : 'Refresh'}</Button>
    </div>
    <ConfirmDialog open={confirmVerbose} title={zh ? '开启插件详细诊断？' : 'Enable verbose plugin diagnostics?'} message={disclosure} confirmLabel={zh ? '临时开启' : 'Enable temporarily'} onOpenChange={setConfirmVerbose} onConfirm={() => { setConfirmVerbose(false); void run('configure', { saveToDisk: true, verbose: true }); }} />
  </section>;
}
