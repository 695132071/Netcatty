export const VAULT_HOST_DRAG_ID = 'host-id';
export const VAULT_HOST_DRAG_IDS = 'host-ids';

export interface VaultHostDragWriter {
  effectAllowed: string;
  setData: (type: string, value: string) => void;
}

export function resolveVaultHostDragIds(input: {
  hostId: string;
  isMultiSelectMode: boolean;
  selectedHostIds: ReadonlySet<string>;
}): string[] | null {
  if (!input.isMultiSelectMode) return [input.hostId];
  if (!input.selectedHostIds.has(input.hostId)) return null;
  return [
    input.hostId,
    ...input.selectedHostIds,
  ].filter((id, index, ids) => id.length > 0 && ids.indexOf(id) === index);
}

export function isVaultHostDraggable(
  isMultiSelectMode: boolean,
  selectedHostIds: ReadonlySet<string> | undefined,
  hostId: string,
): boolean {
  return resolveVaultHostDragIds({
    hostId,
    isMultiSelectMode,
    selectedHostIds: selectedHostIds ?? new Set(),
  }) !== null;
}

export function encodeVaultHostDragIds(ids: readonly string[]): string {
  return JSON.stringify(ids);
}

export function decodeVaultHostDragIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

export function applyVaultHostDragData(dataTransfer: VaultHostDragWriter, ids: readonly string[]): void {
  if (ids.length === 0) return;
  dataTransfer.effectAllowed = 'copyMove';
  dataTransfer.setData(VAULT_HOST_DRAG_ID, ids[0]);
  if (ids.length > 1) dataTransfer.setData(VAULT_HOST_DRAG_IDS, encodeVaultHostDragIds(ids));
}

export function readVaultDraggedHostIds(getData: (type: string) => string): string[] {
  const many = decodeVaultHostDragIds(getData(VAULT_HOST_DRAG_IDS));
  if (many.length > 0) return many;
  const single = getData(VAULT_HOST_DRAG_ID)?.trim() ?? '';
  return single ? [single] : [];
}

export function dispatchVaultHostGroupMove(input: {
  hostIds: readonly string[];
  groupPath: string | null;
  moveHostToGroup?: (hostId: string, groupPath: string | null) => void;
  moveHostsToGroup?: (hostIds: ReadonlySet<string>, groupPath: string | null) => void;
}): boolean {
  const ids: string[] = [];
  for (const id of input.hostIds) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return false;
  if (input.moveHostsToGroup) {
    input.moveHostsToGroup(new Set(ids), input.groupPath);
    return true;
  }
  if (ids.length === 1 && input.moveHostToGroup) {
    input.moveHostToGroup(ids[0], input.groupPath);
    return true;
  }
  return false;
}
