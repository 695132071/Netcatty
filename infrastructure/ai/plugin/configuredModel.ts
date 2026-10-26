import { localStorageAdapter } from '../../persistence/localStorageAdapter';
import { STORAGE_KEY_AI_ACTIVE_MODEL, STORAGE_KEY_AI_ACTIVE_PROVIDER, STORAGE_KEY_AI_PROVIDERS } from '../../config/storageKeys';
import type { ProviderConfig } from '../types';

// Host renderer only. Read the existing configured provider/model without
// loading AgentRuntime or syncing/inheriting the Agent's permission policy.
export function getConfiguredPluginModel() {
  const providers = localStorageAdapter.read<ProviderConfig[]>(STORAGE_KEY_AI_PROVIDERS) ?? [];
  const activeProviderId = localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_PROVIDER);
  const activeModelId = localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_MODEL);
  const provider = providers.find((item) => item.id === activeProviderId && item.enabled);
  if (!provider) return null;
  const config = { ...provider, defaultModel: activeModelId || provider.defaultModel };
  if (!config.defaultModel) return null;
  return { config, label: `${config.name} · ${config.defaultModel}`.slice(0, 160), revision: JSON.stringify(config) };
}
