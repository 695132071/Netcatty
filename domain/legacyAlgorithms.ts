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

export interface PrepareConnectionHostOptions {
  /**
   * Global opt-in for SSH connections with no saved host.
   * Missing or any non-true value stays off.
   */
  temporaryConnectionsAllowLegacyAlgorithms?: boolean;
  /**
   * Global opt-in that starts SSH connections with no saved host in network
   * device mode. Missing or any non-true value leaves deviceType alone.
   */
  temporaryConnectionsNetworkDeviceMode?: boolean;
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

function readPrepareConnectionHostOptions(
  options?: boolean | PrepareConnectionHostOptions,
): PrepareConnectionHostOptions {
  if (typeof options === "boolean") {
    return { temporaryConnectionsAllowLegacyAlgorithms: options };
  }
  return options ?? {};
}

/** Read the two temporary-connection toggles from the settings object given now. */
export function temporaryConnectionPrepareOptions(
  settings: {
    temporaryConnectionsAllowLegacyAlgorithms?: boolean;
    temporaryConnectionsNetworkDeviceMode?: boolean;
  } | null | undefined,
): PrepareConnectionHostOptions {
  return {
    temporaryConnectionsAllowLegacyAlgorithms:
      settings?.temporaryConnectionsAllowLegacyAlgorithms,
    temporaryConnectionsNetworkDeviceMode:
      settings?.temporaryConnectionsNetworkDeviceMode,
  };
}

/**
 * Stamp temporary-connection defaults onto unsaved temporary SSH hosts.
 * Saved hosts, and ephemeral clones of saved hosts, are returned unchanged so
 * their own values (including a later group default) still apply.
 *
 * A boolean second argument is the legacy-algorithm opt-in, matching callers
 * from before network device mode existed.
 */
export function prepareConnectionHost<T extends Host>(
  host: T,
  options?: boolean | PrepareConnectionHostOptions,
): T {
  if (!isTemporarySshHost(host)) return host;
  const resolved = readPrepareConnectionHostOptions(options);
  const legacyAlgorithms = resolveConnectionLegacyAlgorithms({
    hasSavedHost: false,
    temporaryConnectionsAllowLegacyAlgorithms: resolved.temporaryConnectionsAllowLegacyAlgorithms,
  });
  const legacyUnchanged = (host.legacyAlgorithms === true) === legacyAlgorithms;
  // Mosh and ET are stored as SSH plus a transport flag. Network device mode
  // is a plain-SSH CLI behavior; stamping it onto those hosts makes later
  // raw-host checks (such as the copy-session cwd probe) treat them as
  // network gear.
  const stampNetworkDevice = resolved.temporaryConnectionsNetworkDeviceMode === true
    && host.moshEnabled !== true
    && host.etEnabled !== true;
  const deviceTypeUnchanged = !stampNetworkDevice || host.deviceType === "network";
  if (legacyUnchanged && deviceTypeUnchanged) return host;
  return {
    ...host,
    ...(legacyUnchanged ? {} : { legacyAlgorithms }),
    ...(stampNetworkDevice ? { deviceType: "network" as const } : {}),
  };
}
