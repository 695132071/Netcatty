import type { ContainerRuntimeId, ContainerSourceId } from '../../../domain/systemManager/containerRuntime';
import { isContainerSource } from '../../../domain/systemManager/containerRuntime';
import { STORAGE_KEY_CONTAINER_RUNTIME } from '../../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../../infrastructure/persistence/localStorageAdapter';

export interface ContainerRuntimePreference {
  source: ContainerSourceId;
  engine?: ContainerRuntimeId;
  context?: string;
  namespace?: string;
}

type PreferenceStore = Record<string, ContainerRuntimePreference>;

const CONTAINER_ENGINES = new Set<ContainerRuntimeId>(['docker', 'podman', 'nerdctl']);

function readStore(): PreferenceStore {
  const value = localStorageAdapter.read<PreferenceStore>(STORAGE_KEY_CONTAINER_RUNTIME);
  return value && typeof value === 'object' ? value : {};
}

export function readContainerRuntimePreference(hostId: string): ContainerRuntimePreference | null {
  if (!hostId) return null;
  const entry = readStore()[hostId];
  if (!entry || !isContainerSource(entry.source)) return null;
  return {
    source: entry.source,
    engine: entry.engine && CONTAINER_ENGINES.has(entry.engine) ? entry.engine : undefined,
    context: typeof entry.context === 'string' ? entry.context : undefined,
    namespace: typeof entry.namespace === 'string' ? entry.namespace : undefined,
  };
}

export function writeContainerRuntimePreference(hostId: string, entry: ContainerRuntimePreference): void {
  if (!hostId || !isContainerSource(entry.source)) return;
  const store = readStore();
  store[hostId] = entry;
  localStorageAdapter.write(STORAGE_KEY_CONTAINER_RUNTIME, store);
}
