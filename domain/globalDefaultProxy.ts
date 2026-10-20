/**
 * App-wide default proxy profile. Settings publish the saved id here so
 * `applyGroupDefaults` can apply it for every connection path, including
 * callers that pass empty group defaults.
 */
let activeId: string | undefined;
const listeners = new Set<() => void>();
let registrationSeq = 0;
// Several settings hooks can be mounted at once (AppLockGate plus a settings
// tab). Each registration owns its cleanup so unmounting one instance falls
// back to the setter that is still mounted.
const persistSetters: Array<{
  id: number;
  setter: (id: string | undefined) => void;
}> = [];

export const normalizeGlobalDefaultProxyProfileId = (
  value: unknown,
): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

export const getActiveGlobalDefaultProxyProfileId = (): string | undefined => activeId;

export const publishActiveGlobalDefaultProxyProfileId = (value: unknown): void => {
  const next = normalizeGlobalDefaultProxyProfileId(value);
  if (next === activeId) return;
  activeId = next;
  for (const listener of listeners) listener();
};

export const subscribeActiveGlobalDefaultProxyProfileId = (
  listener: () => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const registerGlobalDefaultProxyProfileSetter = (
  setter: (id: string | undefined) => void,
): (() => void) => {
  const id = ++registrationSeq;
  persistSetters.push({ id, setter });
  return () => {
    const index = persistSetters.findIndex((entry) => entry.id === id);
    if (index >= 0) persistSetters.splice(index, 1);
  };
};

/** Clear the saved global default and persist that choice when settings are mounted. */
export const clearActiveGlobalDefaultProxyProfile = (): void => {
  const persistSetter = persistSetters[persistSetters.length - 1]?.setter;
  if (persistSetter) {
    persistSetter(undefined);
    return;
  }
  publishActiveGlobalDefaultProxyProfileId(undefined);
};
