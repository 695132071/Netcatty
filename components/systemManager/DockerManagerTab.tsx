import { Box, Layers } from 'lucide-react';
import React, { memo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { useContainerRuntimeSelection } from '../../application/state/systemManager/useContainerRuntimeSelection';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import type { ContainerSourceId } from '../../domain/systemManager/containerRuntime';
import type { SessionCapabilities } from '../../domain/systemManager/types';
import type { TerminalSession } from '../../types';
import { cn } from '../../lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { DockerContainersPanel } from './DockerContainersPanel';
import { DockerImagesPanel } from './DockerImagesPanel';
import { KubernetesPodsPanel } from './KubernetesPodsPanel';
import { SystemPanelShell } from './SystemPanelUi';

type Backend = ReturnType<typeof useSystemManagerBackend>;
type DockerSubTab = 'containers' | 'images';

const RUNTIME_LABEL: Record<ContainerSourceId, string> = {
  docker: 'systemManager.runtime.docker',
  podman: 'systemManager.runtime.podman',
  nerdctl: 'systemManager.runtime.nerdctl',
  kubernetes: 'systemManager.runtime.kubernetes',
};

interface DockerManagerTabProps {
  sessionId: string;
  parentSession: TerminalSession;
  capabilities?: SessionCapabilities;
  isVisible: boolean;
  warmupEnabled?: boolean;
  backend: Backend;
  listRefreshIntervalSec: number;
  statsRefreshIntervalSec: number;
}

function CompactSelect({
  value,
  options,
  ariaLabel,
  section,
  onChange,
  className,
}: {
  value: string;
  options: { id: string; label: string }[];
  ariaLabel: string;
  section: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={ariaLabel}
        data-section={section}
        className={cn(
          "h-6 w-auto max-w-[9.5rem] gap-1 rounded border-border/40 bg-transparent px-2 py-0 text-[11px] shadow-none",
          className,
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id} className="text-xs">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export const DockerManagerTab = memo(function DockerManagerTab({
  sessionId,
  parentSession,
  capabilities,
  isVisible,
  warmupEnabled = false,
  backend,
  listRefreshIntervalSec,
  statsRefreshIntervalSec,
}: DockerManagerTabProps) {
  const { t } = useI18n();
  const [subTab, setSubTab] = useState<DockerSubTab>('containers');
  const {
    source,
    selectSource,
    contextName,
    selectContext,
    namespaceName,
    setNamespaceName,
    contexts,
    namespaces,
    scopeError,
    reloadScopes,
    runtime,
    detected,
    showRuntimeSwitcher,
  } = useContainerRuntimeSelection({
    sessionId,
    hostKey: parentSession.hostId || sessionId,
    capabilities,
    backend,
  });

  const tabs: { id: DockerSubTab; icon: typeof Box; label: string }[] = [
    { id: 'containers', icon: Box, label: t('systemManager.docker.subTabs.containers') },
    { id: 'images', icon: Layers, label: t('systemManager.docker.subTabs.images') },
  ];

  return (
    <SystemPanelShell section="system-manager-docker">
      <div className="shrink-0 flex items-center gap-1 px-2 py-1 border-b border-border/30">
        {source !== 'kubernetes' && tabs.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            className={cn(
              'flex items-center gap-1.5 px-2 py-1 rounded text-[11px] transition-colors',
              subTab === id
                ? 'bg-muted text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setSubTab(id)}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
        {showRuntimeSwitcher && source && detected.includes(source) && (
          <CompactSelect
            value={source}
            ariaLabel={t('systemManager.runtime.switch')}
            section="container-runtime-switcher"
            className="shrink-0"
            options={detected.map((id) => ({ id, label: t(RUNTIME_LABEL[id]) }))}
            onChange={selectSource}
          />
        )}
        {source === 'kubernetes' && contextName && contexts.some((item) => item.name === contextName) && (
          <CompactSelect
            value={contextName}
            ariaLabel={t('systemManager.k8s.context')}
            section="k8s-context-select"
            className="w-full min-w-0 max-w-none flex-1"
            options={contexts.map((item) => ({ id: item.name, label: item.name }))}
            onChange={selectContext}
          />
        )}
        {source === 'kubernetes' && namespaceName && namespaces.includes(namespaceName) && (
          <CompactSelect
            value={namespaceName}
            ariaLabel={t('systemManager.k8s.namespace')}
            section="k8s-namespace-select"
            className="shrink-0"
            options={namespaces.map((name) => ({ id: name, label: name }))}
            onChange={setNamespaceName}
          />
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {source && source !== 'kubernetes' && (
          <>
            <div className={cn('flex-1 min-h-0 flex flex-col', subTab !== 'containers' && 'hidden')}>
              <DockerContainersPanel
                sessionId={sessionId}
                parentSession={parentSession}
                runtime={runtime}
                isVisible={isVisible && subTab === 'containers'}
                warmupEnabled={warmupEnabled || (isVisible && subTab !== 'containers')}
                backend={backend}
                listRefreshIntervalSec={listRefreshIntervalSec}
                statsRefreshIntervalSec={statsRefreshIntervalSec}
              />
            </div>
            <div className={cn('flex-1 min-h-0 flex flex-col', subTab !== 'images' && 'hidden')}>
              <DockerImagesPanel
                sessionId={sessionId}
                runtime={runtime}
                isVisible={isVisible && subTab === 'images'}
                warmupEnabled={warmupEnabled || (isVisible && subTab !== 'images')}
                backend={backend}
                listRefreshIntervalSec={listRefreshIntervalSec}
              />
            </div>
          </>
        )}
        {source === 'kubernetes' && (
          <KubernetesPodsPanel
            sessionId={sessionId}
            parentSession={parentSession}
            contextName={contextName}
            namespaceName={namespaceName}
            scopeError={scopeError}
            isVisible={isVisible}
            warmupEnabled={warmupEnabled}
            backend={backend}
            listRefreshIntervalSec={listRefreshIntervalSec}
            onReloadScopes={reloadScopes}
          />
        )}
      </div>
    </SystemPanelShell>
  );
});
