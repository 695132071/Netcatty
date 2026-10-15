import type { TerminalSession } from './models';

export function findReusableHostSession(sessions: TerminalSession[], hostId: string) {
  if (!hostId) return undefined;
  // Auto-reconnect publishes connecting even during the retry delay. A plain
  // disconnected/restored tab needs user action and cannot satisfy host_open.
  const matches = sessions.filter((session) => (
    session.hostId === hostId
    && session.restoreState !== 'restored-disconnected'
    && (session.status === 'connected' || session.status === 'connecting')
  ));
  const picked = matches.find((session) => session.status === 'connected') ?? matches[0];
  return picked ? { sessionId: picked.id, connected: picked.status === 'connected' } : undefined;
}
