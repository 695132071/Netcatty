import type { MonitorPanel } from "./monitorPanels";
export type MonitorStats = NonNullable<
  Awaited<ReturnType<NonNullable<NetcattyBridge["getServerStats"]>>>["stats"]
> & { networkReady?: boolean };
export type MonitorPoint = {
  at: number;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  rx: number | null;
  tx: number | null;
};
export type MonitorHostState = {
  status:
    | "queued"
    | "connecting"
    | "live"
    | "login"
    | "error"
    | "unsupported"
    | "disconnected"
    | "limit";
  at: number;
  stats: MonitorStats | null;
  points: MonitorPoint[];
};
export type MonitorSnapshot = {
  running: string[];
  count: number;
  hostCount: number;
  epoch: number;
  runtimeId: string;
  takenAt: number;
  activeSessions: string[];
  unavailable?: boolean;
  hosts: Record<string, MonitorHostState>;
};
export type MonitorPanelDemand = {
  id: string;
  interval: MonitorPanel["interval"];
  hosts: {
    id: string;
    options?: NetcattySSHOptions;
    status?: "login" | "error";
  }[];
};
export function monitorNeedsAttention(
  state: MonitorHostState | undefined,
  interval: number,
  now = Date.now(),
): boolean {
  if (!state || state.status !== "live" || now - state.at > interval * 2500)
    return true;
  const s = state.stats;
  return (
    !!s &&
    ((s.cpu ?? 0) >= 85 ||
      (s.memTotal && s.memUsed ? s.memUsed / s.memTotal >= 0.9 : false) ||
      s.disks.some((d) => d.percent >= 90))
  );
}
