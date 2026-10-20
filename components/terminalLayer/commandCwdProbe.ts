import { isTerminalSessionEligibleForSftpReuse } from "../../application/state/terminalConnectionReuse";
import type { TerminalSession } from "../../domain/models";
import { resolveHostFollowTerminalCwd, resolveSftpFollowTerminalCwdTargetHost } from "../../domain/sftpFollowTerminalCwd";

type FollowTerminalCwdHost = {
  sftpFollowTerminalCwd?: boolean;
};

type ShouldProbeCommandCwdOptions = {
  restoreTerminalCwd: boolean;
  visibleSftpHost?: FollowTerminalCwdHost | null;
  sessionHost?: FollowTerminalCwdHost | null;
  globalSftpFollowTerminalCwd: boolean;
  restrictExtraSshChannels?: boolean;
};

type CommandCwdProbeSession = Pick<
  TerminalSession,
  "protocol" | "status" | "moshEnabled" | "etEnabled" | "shellType"
>;

/**
 * Sessions whose post-command cwd probe can run.
 *
 * SSH reuses the extra exec channel (`getSessionPwd`). Local POSIX shells have
 * no OSC 7 by default and no SSH channel, but the same probe path can read the
 * PTY process cwd. CMD/PowerShell cannot accept the POSIX restore `cd`.
 */
export const canScheduleCommandCwdProbe = (session: CommandCwdProbeSession): boolean => {
  if (session.status !== "connected") return false;
  if (session.protocol === "local") {
    return session.shellType !== "powershell" && session.shellType !== "cmd";
  }
  return isTerminalSessionEligibleForSftpReuse(session);
};

export const shouldProbeCommandCwd = ({
  restoreTerminalCwd,
  visibleSftpHost,
  sessionHost,
  globalSftpFollowTerminalCwd,
  restrictExtraSshChannels = false,
}: ShouldProbeCommandCwdOptions): boolean => {
  if (restrictExtraSshChannels) return false;
  if (restoreTerminalCwd) return true;

  if (!visibleSftpHost) return false;
  const followHost = resolveSftpFollowTerminalCwdTargetHost(visibleSftpHost, sessionHost);
  return resolveHostFollowTerminalCwd(
    followHost?.sftpFollowTerminalCwd,
    globalSftpFollowTerminalCwd,
  );
};
