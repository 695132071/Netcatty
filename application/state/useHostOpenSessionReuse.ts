import { useCallback, useLayoutEffect, useRef } from 'react';
import type { Host, Identity, SSHKey, TerminalSession } from '../../domain/models';
import { findReusableHostSession } from '../../domain/hostOpenSession';
import { buildSftpHostCredentials } from './sftp/useSftpHostCredentials';
import { buildTransferPoolKey } from './sftp/transferConnectionPool';
import { createHostTerminalSession } from './sessionFactories';

type HostOpenSessionReuseInput = {
  sessions: TerminalSession[];
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  resolveEffectiveHost: (host: Host) => Host;
};

/** Retain the opening connection identity, never credentials in session storage. */
export function useHostOpenSessionReuse({ sessions, hosts, keys, identities, resolveEffectiveHost }: HostOpenSessionReuseInput) {
  const openingKeys = useRef(new Map<string, Promise<string | undefined>>());
  const connectionKey = useCallback((host: Host) => {
    // Reuse the existing credential/chain expansion and transport identity
    // comparison. Presentation names and SFTP-only choices do not change a
    // terminal's destination or login.
    const options = buildSftpHostCredentials({
      host, hosts: hosts.map(resolveEffectiveHost), keys, identities,
    });
    delete options.sudo;
    delete options.fileProtocol;
    for (const hop of options.jumpHosts ?? []) delete hop.label;
    const connectionOptions = {
      ...options,
      protocol: host.protocol || 'ssh',
      moshEnabled: host.moshEnabled,
      moshServerPath: host.moshServerPath,
      etEnabled: host.etEnabled,
      etPort: host.etPort,
      pluginConnection: host.pluginConnection,
      serialConfig: host.protocol === 'serial' ? createHostTerminalSession('', host).serialConfig : undefined,
      agentForwarding: host.agentForwarding,
      x11Forwarding: host.x11Forwarding,
    };
    return buildTransferPoolKey({ ...options, protocol: connectionOptions.protocol, connectionOptions });
  }, [hosts, keys, identities, resolveEffectiveHost]);

  useLayoutEffect(() => {
    const liveIds = new Set(sessions.map((session) => session.id));
    for (const id of openingKeys.current.keys()) {
      if (!liveIds.has(id)) openingKeys.current.delete(id);
    }
    for (const session of sessions) {
      if (openingKeys.current.has(session.id) || session.restoreState) continue;
      const host = hosts.find((candidate) => candidate.id === session.hostId);
      if (!host) continue;
      try {
        openingKeys.current.set(session.id, connectionKey({
          ...resolveEffectiveHost(host),
          hostname: session.hostname,
          username: session.username,
          port: session.port ?? host.port,
          protocol: session.protocol ?? host.protocol,
          moshEnabled: session.moshEnabled ?? host.moshEnabled,
          etEnabled: session.etEnabled ?? host.etEnabled,
          serialConfig: session.serialConfig ?? host.serialConfig,
          pluginConnection: session.pluginConnection ?? host.pluginConnection,
        }).catch(() => undefined));
      } catch {
        openingKeys.current.set(session.id, Promise.resolve(undefined));
      }
    }
  }, [sessions, hosts, connectionKey, resolveEffectiveHost]);

  return useCallback(async (hostId: string) => {
    const host = hosts.find((candidate) => candidate.id === hostId);
    if (!host) return undefined;
    try {
      const requestedKey = await connectionKey(resolveEffectiveHost(host));
      const matches = await Promise.all(sessions.map(async (session) => (
        session.hostId === hostId && await openingKeys.current.get(session.id) === requestedKey ? session : undefined
      )));
      return findReusableHostSession(matches.filter((session) => session !== undefined), hostId);
    } catch {
      // An unresolved/changed credential must never select an old transport.
      return undefined;
    }
  }, [hosts, sessions, connectionKey, resolveEffectiveHost]);
}
