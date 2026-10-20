import { useSyncExternalStore } from 'react';

import {
  getActiveGlobalDefaultProxyProfileId,
  subscribeActiveGlobalDefaultProxyProfileId,
} from '../../domain/globalDefaultProxy';

export const useActiveGlobalDefaultProxyProfileId = (): string | undefined => {
  return useSyncExternalStore(
    subscribeActiveGlobalDefaultProxyProfileId,
    getActiveGlobalDefaultProxyProfileId,
    getActiveGlobalDefaultProxyProfileId,
  );
};
