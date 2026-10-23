/** Resolve an explicit placement request without silently changing its target. */
export function resolveAgentHostWorkspace(
  requested: string | undefined,
  activeTabId: string | undefined,
  workspaceIds: readonly string[],
): { workspaceId?: string; error?: string } {
  if (requested === undefined) return {};
  const workspaceId = requested === 'current' ? activeTabId : requested.trim();
  if (!workspaceId || !workspaceIds.includes(workspaceId)) {
    return { error: `Workspace "${requested}" is not available. Select a workspace or provide its id.` };
  }
  return { workspaceId };
}
