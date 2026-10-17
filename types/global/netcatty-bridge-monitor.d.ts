export {};
declare global {
  interface NetcattyBridge {
    monitorUpdate?(
      panels: import("../../domain/monitorRuntime").MonitorPanelDemand[],
    ): Promise<import("../../domain/monitorRuntime").MonitorSnapshot>;
    monitorSnapshot?(): Promise<
      import("../../domain/monitorRuntime").MonitorSnapshot
    >;
    monitorStopAll?(): Promise<void>;
    monitorRetry?(hostId: string): Promise<void>;
  }
}
