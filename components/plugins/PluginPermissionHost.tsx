import { usePluginPermissionPrompt } from '../../application/state/usePluginPermissionPrompt';
import { useI18n } from '../../application/i18n/I18nProvider';
import { describePluginPermission } from '@/domain/pluginPermissionDescriptions.cjs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';

/** Rendered only by the trusted app, never inside a plugin view. */
export function PluginPermissionHost() {
  const { resolvedLocale } = useI18n();
  const zh = resolvedLocale.startsWith('zh');
  const { prompt, busy, respond } = usePluginPermissionPrompt();
  if (!prompt) return null;
  const description = describePluginPermission(prompt.permission, resolvedLocale);
  return <Dialog open onOpenChange={(open) => { if (!open) void respond('cancel'); }}>
    <DialogContent className="sm:max-w-[480px]">
      <DialogHeader>
        <DialogTitle>{description.label}</DialogTitle>
        <DialogDescription className="break-words">{prompt.pluginName ?? prompt.pluginId} · {prompt.pluginVersion}</DialogDescription>
      </DialogHeader>
      <p className="text-sm">{description.description}</p>
      {(prompt.relatedPermissions ?? []).map((item, index) => <div key={index} className="space-y-1 text-sm">
        <p>{describePluginPermission(item.permission, resolvedLocale).description}</p>
        <p className="text-xs text-muted-foreground break-all">{item.resources.join(', ')}</p>
      </div>)}
      <p className="text-xs text-muted-foreground break-all">{prompt.pluginId}</p>
      <ul className="max-h-44 overflow-auto space-y-1 text-xs text-muted-foreground">{prompt.resources.map((resource) => <li key={resource} className="break-all">{resource}</li>)}</ul>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => void respond('deny')}>{zh ? '拒绝' : 'Deny'}</Button>
        <Button disabled={busy} onClick={() => void respond('allow')}>{prompt.sessionId && prompt.allowedScopes && !prompt.allowedScopes.includes('once') ? zh ? '允许此会话' : 'Allow for this session' : zh ? '允许此次操作' : 'Allow this operation'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
