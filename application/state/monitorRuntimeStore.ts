import { useSyncExternalStore } from "react";
import type { MonitorSnapshot } from "../../domain/monitorRuntime";
const empty: MonitorSnapshot = {
  running: [],
  count: 0,
  hostCount: 0,
  epoch: 0,
  runtimeId: "",
  takenAt: 0,
  activeSessions: [],
  hosts: {},
};
let snapshot = empty;
const listeners = new Set<() => void>();
export function publishMonitorSnapshot(next: MonitorSnapshot) {
  snapshot = next;
  for (const l of listeners) l();
}
export function publishMonitorUnavailable() {
  publishMonitorSnapshot({ ...empty, unavailable: true });
}
export function useMonitorSnapshot() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => snapshot,
    () => empty,
  );
}
export const monitorActions: {
  start: (id: string) => void;
  stop: (id: string) => void;
  stopAll: () => void;
  retry: (
    id: string,
    credentials?: { username: string; password: string },
  ) => void;
} = {
  start: () => {},
  stop: () => {},
  stopAll: () => {},
  retry: () => {},
};
