import type { TerminalSession } from "../../domain/models";

export type SessionPwdProbe = (
  sessionId: string,
  options?: {
    allowHomeFallback?: boolean;
    allowLoginShellFallback?: boolean;
    timeoutMs?: number;
  },
) => Promise<{ success: boolean; cwd?: string }>;

type CaptureSession = Pick<TerminalSession, "id" | "protocol" | "status" | "lastCwd" | "localStartDir">;

export interface CaptureInheritedCwdOptions {
  /**
   * The session's live tracked cwd (OSC 7 or the post-command cwd probe),
   * sourced from the terminal-state cwd map rather than the session object.
   * This is the freshest value and the one that reflects `cd`s in a running
   * local terminal. The live value stays off `TerminalSession.lastCwd` until
   * session restore persists it.
   */
  liveCwd?: string;
  /**
   * Whether an SSH `/proc` probe is permitted. Callers pass `false` for network
   * devices (e.g. Huawei VRP), where the extra exec channel can drop the whole
   * session — mirrors `shouldProbeSessionCwd` in the terminal cwd-probe path.
   */
  allowSshProbe?: boolean;
  /** Max time to wait on the probe before falling back. */
  probeTimeoutMs?: number;
}

/** Max time to wait on the live SSH cwd probe before falling back to lastCwd. */
export const DEFAULT_INHERITED_CWD_PROBE_TIMEOUT_MS = 1500;

/**
 * Resolve the working directory a clone/split should inherit from its source.
 *
 * Priority: live tracked cwd (OSC 7 or post-command probe) -> live SSH `/proc` probe (when allowed)
 * -> tracked `lastCwd` snapshot -> local `localStartDir`. The probe is raced
 * against a short timeout so a slow/wedged connection can't block tab creation,
 * and is skipped entirely when `allowSshProbe` is false. Returns undefined when
 * nothing is known (caller then behaves as before: login dir).
 */
export async function captureInheritedCwd(
  session: CaptureSession,
  getSessionPwd: SessionPwdProbe,
  options: CaptureInheritedCwdOptions = {},
): Promise<string | undefined> {
  const {
    liveCwd,
    allowSshProbe = true,
    probeTimeoutMs = DEFAULT_INHERITED_CWD_PROBE_TIMEOUT_MS,
  } = options;

  const live = liveCwd?.trim();
  if (live) return live;

  const protocol = session.protocol ?? "ssh";
  const isRemoteSsh = protocol === "ssh" || protocol === undefined;

  if (isRemoteSsh && allowSshProbe && session.status === "connected") {
    // Never rejects: a failed/absent probe resolves to undefined so the race
    // below can't leave a dangling unhandled rejection when the timeout wins.
    const probePromise = getSessionPwd(session.id, {
      allowHomeFallback: false,
      // Keep the backend exec within the same budget as this UI-side timeout.
      timeoutMs: probeTimeoutMs,
    })
      .then((res) => (res?.success ? res.cwd?.trim() : undefined))
      .catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), probeTimeoutMs);
    });

    const probed = await Promise.race([probePromise, timeoutPromise]);
    if (timer) clearTimeout(timer);
    if (probed) return probed;
  }

  const tracked = session.lastCwd?.trim();
  if (tracked) return tracked;

  if (protocol === "local") return session.localStartDir;
  return undefined;
}
