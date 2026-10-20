import { useCallback, useEffect, useRef, useState } from 'react';
import type { useSystemManagerBackend } from '../useSystemManagerBackend';
import { useStableTranslate } from '../useSystemManager';
import type {
  ContainerRuntimeId,
  ContainerSourceId,
  KubeContextInfo,
} from '../../../domain/systemManager/containerRuntime';
import {
  describeRuntimeFailure,
  firstContainerRuntime,
  isAutomaticRuntimeFallback,
  isKubectlForbiddenError,
  reconcileContainerSource,
  sourcesFromCapabilities,
} from '../../../domain/systemManager/containerRuntime';
import type { SessionCapabilities } from '../../../domain/systemManager/types';
import {
  readContainerRuntimePreference,
  writeContainerRuntimePreference,
} from './containerRuntimePreference';

type Backend = ReturnType<typeof useSystemManagerBackend>;

interface UseContainerRuntimeSelectionOptions {
  sessionId: string;
  hostKey: string;
  capabilities?: SessionCapabilities;
  backend: Backend;
}

export function useContainerRuntimeSelection({
  sessionId,
  hostKey,
  capabilities,
  backend,
}: UseContainerRuntimeSelectionOptions) {
  const stableT = useStableTranslate();
  const detected = sourcesFromCapabilities(capabilities);
  const detectedKey = detected.join('|');
  const [source, setSource] = useState<ContainerSourceId | null>(() => {
    const remembered = readContainerRuntimePreference(hostKey);
    return reconcileContainerSource(detected, null, remembered);
  });
  const [contextName, setContextName] = useState<string | null>(() => (
    readContainerRuntimePreference(hostKey)?.context ?? null
  ));
  const [namespaceName, setNamespaceName] = useState<string | null>(() => (
    readContainerRuntimePreference(hostKey)?.namespace ?? null
  ));
  const [contexts, setContexts] = useState<KubeContextInfo[]>([]);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [scopeNonce, setScopeNonce] = useState(0);
  const skipPersist = useRef(true);
  const namespaceNameRef = useRef(namespaceName);
  namespaceNameRef.current = namespaceName;

  useEffect(() => {
    skipPersist.current = true;
    const remembered = readContainerRuntimePreference(hostKey);
    setSource(reconcileContainerSource(detected, null, remembered));
    setContextName(remembered?.context ?? null);
    setNamespaceName(remembered?.namespace ?? null);
    setContexts([]);
    setNamespaces([]);
    setScopeError(null);
    // Detection is reconciled by the next effect so a host switch does not
    // keep the previous host's in-memory selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostKey]);

  useEffect(() => {
    const available = sourcesFromCapabilities(capabilities);
    setSource((current) => reconcileContainerSource(
      available,
      current,
      readContainerRuntimePreference(hostKey),
    ));
  }, [capabilities, detectedKey, hostKey]);

  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false;
      return;
    }
    if (!source) return;
    const remembered = readContainerRuntimePreference(hostKey);
    const available = sourcesFromCapabilities(capabilities);
    if (isAutomaticRuntimeFallback(remembered, source, available)) return;
    const engine = source === 'kubernetes'
      ? (remembered?.engine ?? firstContainerRuntime(available) ?? undefined)
      : source;
    writeContainerRuntimePreference(hostKey, {
      source,
      engine,
      context: contextName || undefined,
      namespace: namespaceName || undefined,
    });
  }, [capabilities, contextName, hostKey, namespaceName, source]);

  useEffect(() => {
    if (source !== 'kubernetes') return undefined;
    let cancelled = false;
    void backend.kubectl({ sessionId, op: 'contexts' }).then((result) => {
      if (cancelled) return;
      if (!result.success || !result.contexts) {
        setContexts([]);
        setScopeError(describeRuntimeFailure(
          result,
          stableT,
          stableT('systemManager.errors.loadKubernetes'),
          contextName,
        ));
        return;
      }
      setScopeError(null);
      const available = result.contexts;
      const kept = contextName && available.some((item) => item.name === contextName)
        ? contextName
        : null;
      const next = kept
        ?? available.find((item) => item.current)?.name
        ?? available[0]?.name
        ?? null;
      setContexts(available);
      setContextName(next);
      if (!kept) {
        const configured = available.find((item) => item.name === next)?.namespace || 'default';
        setNamespaceName(next ? configured : null);
        setNamespaces([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [backend, contextName, sessionId, source, scopeNonce, stableT]);

  useEffect(() => {
    if (source !== 'kubernetes' || !contextName) return undefined;
    let cancelled = false;
    void backend.kubectl({
      sessionId,
      op: 'namespaces',
      context: contextName,
    }).then((result) => {
      if (cancelled) return;
      if (!result.success || !result.namespaces) {
        const message = result.error || '';
        if (isKubectlForbiddenError(message)) {
          const configured = contexts.find((item) => item.name === contextName)?.namespace || 'default';
          const fallback = namespaceNameRef.current || configured;
          setScopeError(null);
          setNamespaceName((current) => current || fallback);
          setNamespaces([fallback]);
          return;
        }
        setScopeError(describeRuntimeFailure(
          result,
          stableT,
          stableT('systemManager.errors.loadKubernetes'),
          contextName,
        ));
        return;
      }
      setScopeError(null);
      setNamespaces(result.namespaces);
      setNamespaceName((current) => {
        if (current && result.namespaces?.includes(current)) return current;
        const configured = contexts.find((item) => item.name === contextName)?.namespace;
        if (configured && result.namespaces?.includes(configured)) return configured;
        if (result.namespaces?.includes('default')) return 'default';
        return result.namespaces?.[0] ?? null;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [backend, contextName, contexts, sessionId, source, scopeNonce, stableT]);

  const selectSource = useCallback((value: string) => {
    if (value !== 'docker' && value !== 'podman' && value !== 'nerdctl' && value !== 'kubernetes') return;
    setSource(value);
    const remembered = readContainerRuntimePreference(hostKey);
    const available = sourcesFromCapabilities(capabilities);
    const engine = value === 'kubernetes'
      ? (remembered?.engine ?? firstContainerRuntime(available) ?? undefined)
      : value;
    writeContainerRuntimePreference(hostKey, {
      source: value,
      engine,
      context: contextName || undefined,
      namespace: namespaceName || undefined,
    });
  }, [capabilities, contextName, hostKey, namespaceName]);

  const selectContext = useCallback((value: string) => {
    setContextName(value);
    const configured = contexts.find((item) => item.name === value)?.namespace ?? null;
    setNamespaceName(configured);
  }, [contexts]);

  const reloadScopes = useCallback(() => {
    setScopeNonce((value) => value + 1);
  }, []);

  const runtime: ContainerRuntimeId = source && source !== 'kubernetes' ? source : 'docker';
  const showRuntimeSwitcher = detected.length > 1;

  return {
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
  };
}
