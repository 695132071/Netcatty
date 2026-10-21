import {
  applyVaultHostDragData,
  resolveVaultHostDragIds,
} from "../../domain/vaultHostDrag";

export function attachVaultHostDragBadge(dataTransfer: DataTransfer, label: string): void {
  if (typeof document === "undefined") return;
  const badge = document.createElement("div");
  badge.textContent = label;
  badge.setAttribute("data-vault-host-drag-badge", "true");
  badge.style.position = "fixed";
  badge.style.top = "-1000px";
  badge.style.left = "0";
  badge.style.zIndex = "2147483647";
  badge.style.padding = "2px 8px";
  badge.style.borderRadius = "999px";
  badge.style.background = "#111827";
  badge.style.color = "#ffffff";
  badge.style.font = "12px/16px sans-serif";
  badge.style.pointerEvents = "none";
  document.body.appendChild(badge);
  dataTransfer.setDragImage(badge, badge.offsetWidth / 2, badge.offsetHeight / 2);
  window.setTimeout(() => badge.remove(), 0);
}

export function beginVaultHostCardDrag(input: {
  dataTransfer: DataTransfer;
  hostId: string;
  isMultiSelectMode: boolean;
  selectedHostIds: ReadonlySet<string> | undefined;
  countLabel: (count: number) => string;
}): string[] | null {
  const ids = resolveVaultHostDragIds({
    hostId: input.hostId,
    isMultiSelectMode: input.isMultiSelectMode,
    selectedHostIds: input.selectedHostIds ?? new Set<string>(),
  });
  if (!ids) return null;
  applyVaultHostDragData(input.dataTransfer, ids);
  if (ids.length > 1) attachVaultHostDragBadge(input.dataTransfer, input.countLabel(ids.length));
  return ids;
}
