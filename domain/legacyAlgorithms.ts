import type { Host } from "./models";

export interface ConnectionLegacyAlgorithmInput {
  /** True when a saved vault host owns this connection, including an ephemeral clone of one. */
  hasSavedHost: boolean;
  /** Per-host value after that host's own settings are applied. */
  hostLegacyAlgorithms?: boolean;
  /**
   * Global opt-in for SSH connections with no saved host.
   * Missing or any non-true value stays off.
   */
  temporaryConnectionsAllowLegacyAlgorithms?: boolean;
}

/**
 * Saved hosts keep their own legacy-algorithm choice. Connections with no
 * saved host use the global temporary-connection opt-in, which defaults to
 * off. The address is not an input, so 127.0.0.1 alone never opts in.
 */
export function resolveConnectionLegacyAlgorithms(
  input: ConnectionLegacyAlgorithmInput,
): boolean {
  if (input.hasSavedHost) return input.hostLegacyAlgorithms === true;
  return input.temporaryConnectionsAllowLegacyAlgorithms === true;
}

export function connectionHasSavedHost(
  host: Pick<Host, "ephemeral" | "backedBySavedHost"> | null | undefined,
): boolean {
  if (!host) return false;
  if (host.backedBySavedHost === true) return true;
  return host.ephemeral !== true;
}

function isTemporarySshHost(
  host: Pick<Host, "ephemeral" | "backedBySavedHost" | "protocol">,
): boolean {
  if (connectionHasSavedHost(host)) return false;
  return host.protocol === undefined || host.protocol === "ssh";
}

/**
 * Stamp the resolved legacy-algorithm flag onto unsaved temporary SSH hosts.
 * Saved hosts, and ephemeral clones of saved hosts, are returned unchanged so
 * their own value (including a later group default) still applies.
 */
export function prepareConnectionHost<T extends Host>(
  host: T,
  temporaryConnectionsAllowLegacyAlgorithms?: boolean,
): T {
  if (!isTemporarySshHost(host)) return host;
  const legacyAlgorithms = resolveConnectionLegacyAlgorithms({
    hasSavedHost: false,
    temporaryConnectionsAllowLegacyAlgorithms,
  });
  if ((host.legacyAlgorithms === true) === legacyAlgorithms) return host;
  return { ...host, legacyAlgorithms };
}
