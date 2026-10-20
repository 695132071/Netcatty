import { Box, FileText, Info, Terminal, Trash2 } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import { usePolling, useStableTranslate } from '../../application/state/useSystemManager';
import type { KubectlPodInfo } from '../../domain/systemManager/containerRuntime';
import {
  buildKubectlDescribeCommand,
  buildKubectlExecShellCommand,
  buildKubectlLogsCommand,
  describeRuntimeFailure,
  podStatusMessageKey,
} from '../../domain/systemManager/containerRuntime';
import type { TerminalSession } from '../../types';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { useStableListOrder } from './listStable';
import { openInteractiveTerminal } from './openInteractiveTerminal';
import { SystemPanelConfirmDialog } from './SystemPanelConfirmDialog';
import {
  SystemPanelEmpty,
  SystemPanelError,
  SystemPanelList,
  SystemPanelLoading,
  SystemPanelMetaBar,
  SystemPanelRefreshButton,
  SystemPanelRoundButton,
  SystemPanelRow,
  SystemPanelSearch,
  SystemPanelStatusBadge,
  SystemPanelToolbar,
} from './SystemPanelUi';
import { showSystemManagerError } from './systemManagerToast';

type Backend = ReturnType<typeof useSystemManagerBackend>;

interface KubernetesPodsPanelProps {
  sessionId: string;
  parentSession: TerminalSession;
  contextName: string | null;
  namespaceName: string | null;
  scopeError?: string | null;
  isVisible: boolean;
  warmupEnabled?: boolean;
  backend: Backend;
  listRefreshIntervalSec: number;
  onReloadScopes: () => void;
}

function podTone(status: string): 'success' | 'warning' | 'muted' {
  if (status === 'Running') return 'success';
  if (status === 'Pending' || status === 'Completed' || status === 'Succeeded') return 'muted';
  return 'warning';
}

const KubernetesPodRow = memo(function KubernetesPodRow({
  pod,
  selected,
  pendingDelete,
  onSelect,
  onShell,
  onLogs,
  onDescribe,
  onDelete,
}: {
  pod: KubectlPodInfo;
  selected: boolean;
  pendingDelete: boolean;
  onSelect: (pod: KubectlPodInfo) => void;
  onShell: (pod: KubectlPodInfo) => void;
  onLogs: (pod: KubectlPodInfo) => void;
  onDescribe: (pod: KubectlPodInfo) => void;
  onDelete: (pod: KubectlPodInfo) => void;
}) {
  const { t } = useI18n();
  const statusKey = podStatusMessageKey(pod.status);
  const statusLabel = statusKey ? t(statusKey) : pod.status;
  return (
    <SystemPanelRow
      selected={selected}
      onClick={() => onSelect(pod)}
      leading={<Box size={14} className="text-muted-foreground" />}
      title={pod.name}
      subtitle={`${pod.containers.join(', ') || '—'} · ${t('systemManager.k8s.restarts', { count: String(pod.restarts) })}${pod.age ? ` · ${pod.age}` : ''}`}
      trailing={(
        <div className="flex shrink-0 items-center gap-1">
          <SystemPanelStatusBadge tone={podTone(pod.status)}>{statusLabel}</SystemPanelStatusBadge>
          {pod.shellContainers.length > 0 && (
            <SystemPanelRoundButton title={t('systemManager.docker.shell')} onClick={() => onShell(pod)}>
              <Terminal size={12} />
            </SystemPanelRoundButton>
          )}
          <SystemPanelRoundButton title={t('systemManager.docker.logs')} onClick={() => onLogs(pod)}>
            <FileText size={12} />
          </SystemPanelRoundButton>
          <SystemPanelRoundButton title={t('systemManager.k8s.describe')} onClick={() => onDescribe(pod)}>
            <Info size={12} />
          </SystemPanelRoundButton>
          <SystemPanelRoundButton
            title={t('systemManager.k8s.delete')}
            destructive
            loading={pendingDelete}
            onClick={() => onDelete(pod)}
          >
            <Trash2 size={12} />
          </SystemPanelRoundButton>
        </div>
      )}
    />
  );
});

export const KubernetesPodsPanel = memo(function KubernetesPodsPanel({
  sessionId,
  parentSession,
  contextName,
  namespaceName,
  scopeError = null,
  isVisible,
  warmupEnabled = false,
  backend,
  listRefreshIntervalSec,
  onReloadScopes,
}: KubernetesPodsPanelProps) {
  const { t } = useI18n();
  const stableT = useStableTranslate();
  const [query, setQuery] = useState('');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [confirmPod, setConfirmPod] = useState<string | null>(null);
  const [containerPrompt, setContainerPrompt] = useState<{
    pod: KubectlPodInfo;
    action: 'shell' | 'logs';
  } | null>(null);

  const scopeKey = `${sessionId}:${contextName ?? ''}:${namespaceName ?? ''}`;

  useEffect(() => {
    setSelectedName(null);
    setPendingDelete(null);
    setConfirmPod(null);
    setContainerPrompt(null);
  }, [scopeKey]);

  const podsFetcher = useCallback(async () => {
    if (!contextName || !namespaceName) return [];
    const result = await backend.kubectl({
      sessionId,
      op: 'pods',
      context: contextName,
      namespace: namespaceName,
    });
    if (!result.success || !result.pods) {
      throw new Error(describeRuntimeFailure(
        result,
        stableT,
        stableT('systemManager.errors.loadPods'),
        contextName,
      ));
    }
    return result.pods;
  }, [backend, contextName, namespaceName, sessionId, stableT]);

  const listIntervalMs = Math.max(3, listRefreshIntervalSec) * 1000;
  const { data: pods, error, loading, refresh } = usePolling<KubectlPodInfo[]>(
    podsFetcher,
    listIntervalMs,
    (isVisible || warmupEnabled) && !!contextName && !!namespaceName,
    undefined,
    { poll: isVisible, resetKey: scopeKey },
  );

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (pods ?? []).filter((pod) => {
      if (!q) return true;
      const statusKey = podStatusMessageKey(pod.status);
      const statusLabel = (statusKey ? t(statusKey) : pod.status).toLowerCase();
      return pod.name.toLowerCase().includes(q)
        || pod.status.toLowerCase().includes(q)
        || statusLabel.includes(q)
        || pod.containers.some((name) => name.toLowerCase().includes(q));
    });
  }, [pods, query, t]);

  const displayList = useStableListOrder<KubectlPodInfo, string>(
    matched,
    (pod) => pod.name,
    `${scopeKey}|${query}`,
    (a, b) => a.name.localeCompare(b.name),
  );

  const openCommand = useCallback(async (title: string, command: string) => {
    const result = await openInteractiveTerminal(backend, parentSession, title, command);
    if (!result.success) {
      showSystemManagerError(result.error || t('systemManager.errors.actionFailed'), t('common.error'));
    }
  }, [backend, parentSession, t]);

  const runPodCommand = useCallback((pod: KubectlPodInfo, action: 'shell' | 'logs' | 'describe', container?: string) => {
    if (!contextName || !namespaceName) return;
    if (action === 'describe') {
      void openCommand(
        `describe: ${pod.name}`,
        buildKubectlDescribeCommand(contextName, namespaceName, pod.name, parentSession.shellType),
      );
      return;
    }
    const containers = action === 'shell' ? pod.shellContainers : pod.containers;
    if (action === 'shell' && containers.length === 0) return;
    if (!container && containers.length > 1) {
      setContainerPrompt({ pod, action });
      return;
    }
    const chosen = container || containers[0];
    if (action === 'shell') {
      void openCommand(
        `pod: ${pod.name}`,
        buildKubectlExecShellCommand(contextName, namespaceName, pod.name, chosen, parentSession.shellType),
      );
      return;
    }
    void openCommand(
      `logs: ${pod.name}`,
      buildKubectlLogsCommand(contextName, namespaceName, pod.name, chosen, parentSession.shellType),
    );
  }, [contextName, namespaceName, openCommand, parentSession.shellType]);

  const deletePod = useCallback(async (name: string) => {
    if (!contextName || !namespaceName) return;
    setPendingDelete(name);
    try {
      const result = await backend.kubectl({
        sessionId,
        op: 'delete',
        context: contextName,
        namespace: namespaceName,
        pod: name,
      });
      if (!result.success) {
        showSystemManagerError(
          describeRuntimeFailure(result, t, t('systemManager.errors.actionFailed'), contextName),
          t('common.error'),
        );
        return;
      }
      if (selectedName === name) setSelectedName(null);
      await refresh();
    } finally {
      setPendingDelete(null);
    }
  }, [backend, contextName, namespaceName, refresh, selectedName, sessionId, t]);

  const visibleError = scopeError || error;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden" data-section="kubernetes-pods">
      <SystemPanelToolbar
        trailing={(
          <SystemPanelRefreshButton
            title={t('history.action.refresh')}
            loading={loading}
            onClick={() => {
              onReloadScopes();
              void refresh();
            }}
          />
        )}
      >
        <SystemPanelSearch
          value={query}
          onChange={setQuery}
          placeholder={t('systemManager.k8s.search')}
        />
      </SystemPanelToolbar>

      <SystemPanelMetaBar>
        {t('systemManager.k8s.meta', { count: String(displayList.length) })}
      </SystemPanelMetaBar>

      <SystemPanelList>
        {!contextName && !visibleError && (
          <SystemPanelEmpty icon={Box} message={t('systemManager.k8s.noContext')} />
        )}
        {visibleError && (
          <SystemPanelError
            message={visibleError}
            onRetry={() => {
              onReloadScopes();
              void refresh();
            }}
            retryLabel={t('history.action.retry')}
            loading={loading}
          />
        )}
        {!visibleError && contextName && displayList.length === 0 && loading && (
          <SystemPanelLoading message={t('systemManager.common.loading')} />
        )}
        {!visibleError && contextName && namespaceName && displayList.length === 0 && !loading && (
          <SystemPanelEmpty icon={Box} message={t('systemManager.k8s.empty')} />
        )}
        {displayList.map((pod) => (
          <KubernetesPodRow
            key={pod.name}
            pod={pod}
            selected={selectedName === pod.name}
            pendingDelete={pendingDelete === pod.name}
            onSelect={(item) => setSelectedName((current) => current === item.name ? null : item.name)}
            onShell={(item) => runPodCommand(item, 'shell')}
            onLogs={(item) => runPodCommand(item, 'logs')}
            onDescribe={(item) => runPodCommand(item, 'describe')}
            onDelete={(item) => setConfirmPod(item.name)}
          />
        ))}
      </SystemPanelList>

      <SystemPanelConfirmDialog
        open={confirmPod !== null}
        title={t('systemManager.k8s.delete')}
        message={t('systemManager.k8s.confirmDelete', { name: confirmPod ?? '' })}
        confirmLabel={t('systemManager.k8s.delete')}
        destructive
        busy={pendingDelete !== null}
        onOpenChange={(open) => { if (!open) setConfirmPod(null); }}
        onConfirm={() => {
          const name = confirmPod;
          setConfirmPod(null);
          if (!name) return;
          void deletePod(name);
        }}
      />

      <Dialog open={containerPrompt !== null} onOpenChange={(open) => { if (!open) setContainerPrompt(null); }}>
        <DialogContent className="sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle>{t('systemManager.k8s.chooseContainer')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            {(containerPrompt?.action === 'shell'
              ? containerPrompt.pod.shellContainers
              : containerPrompt?.pod.containers
            )?.map((name) => (
              <button
                key={name}
                type="button"
                className="rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                onClick={() => {
                  const prompt = containerPrompt;
                  setContainerPrompt(null);
                  if (!prompt) return;
                  runPodCommand(prompt.pod, prompt.action, name);
                }}
              >
                {name}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
});
