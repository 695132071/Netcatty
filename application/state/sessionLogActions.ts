import { STORAGE_KEY_SESSION_LOG_APPLICATION } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

export type SessionLogAction = 'open' | 'reveal' | 'chooseApplication' | 'systemDefault';
type LogApplication = { path: string; name: string };

/** Resolve the session's actual log in its owning process before opening it. */
export async function performSessionLogAction(sessionId: string, action: SessionLogAction): Promise<void> {
  const bridge = netcattyBridge.get();
  if (!bridge?.prepareSessionLog) throw new Error('Session log bridge unavailable');
  if (action === 'reveal') {
    const result = await bridge.revealSessionLog?.({ sessionId });
    if (!result?.success) throw new Error(result?.error || 'Failed to reveal session log');
    return;
  }

  // Check availability before presenting an application picker. Resolve again
  // afterwards so any output received while the picker was open is flushed.
  let result = await bridge.prepareSessionLog({ sessionId });
  if (!result.success || !result.filePath) throw new Error(result.error || 'No saved log for this session');
  let application = localStorageAdapter.read<LogApplication>(STORAGE_KEY_SESSION_LOG_APPLICATION);
  if (action === 'chooseApplication') {
    if (!bridge.selectApplication) throw new Error('Application picker unavailable');
    application = await bridge.selectApplication();
    if (!application) return;
    result = await bridge.prepareSessionLog({ sessionId });
    if (!result.success || !result.filePath) throw new Error(result.error || 'No saved log for this session');
  } else if (action === 'systemDefault') {
    application = null;
  }

  if (application?.path) {
    if (!bridge.openWithApplication) throw new Error('Application opening unavailable');
    const opened = await bridge.openWithApplication(result.filePath, application.path);
    if (!opened) throw new Error('Failed to open session log');
  } else {
    const opened = await bridge.openWithSystemDefault?.(result.filePath);
    if (!opened?.success) throw new Error(opened?.error || 'Failed to open session log');
  }
  // Only remember a choice after a successful launch; failed launches leave
  // the previous preference intact and can be retried or reset from the menu.
  if (action === 'chooseApplication') {
    localStorageAdapter.write(STORAGE_KEY_SESSION_LOG_APPLICATION, application);
  } else if (action === 'systemDefault') {
    localStorageAdapter.remove(STORAGE_KEY_SESSION_LOG_APPLICATION);
  }
}
