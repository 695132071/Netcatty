import { installBrowserLockFixture } from "../testSupport/browserLockFixture";
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { MonitorPanel } from "../../domain/monitorPanels";
import type { CloudProvider, SyncResult, SyncPayload } from "../../domain/sync";

installBrowserLockFixture();

const store = new Map<string, string>();
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
};
const events = new EventTarget();
for (const key of [
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: events[key].bind(events),
  });
}
const windowFixture = Object.assign(events, {
  localStorage: storage,
  CustomEvent,
  setInterval,
  clearInterval,
});
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: storage,
});
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: windowFixture,
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: Object.assign(new EventTarget(), { visibilityState: "hidden" }),
});
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const { useAutoSync } = await import("./useAutoSync");
const { getCloudSyncManager } =
  await import("../../infrastructure/services/CloudSyncManager");
const { saveMonitorPanel, deleteMonitorPanel, writeMonitorPanels } =
  await import("./monitorPanelsStorage");

test("normal manual and debounced auto-sync upload panel creation, edits and deletion", async () => {
  const manager = getCloudSyncManager();
  const snapshot = {
    ...manager.getState(),
    securityState: "UNLOCKED" as const,
    syncState: "IDLE" as const,
    autoSyncEnabled: true,
    providers: {
      ...manager.getState().providers,
      webdav: { provider: "webdav" as const, status: "connected" as const },
    },
  };
  const uploads: SyncPayload[] = [];
  const originals = {
    getState: manager.getState,
    syncAllProviders: manager.syncAllProviders,
    loadSyncBase: manager.loadSyncBase,
    inspectProviderRemote: manager.inspectProviderRemote,
    setPendingLocalSync: manager.setPendingLocalSync,
    setAvailablePluginSyncProviders: manager.setAvailablePluginSyncProviders,
  };
  manager.getState = () => snapshot;
  manager.loadSyncBase = async () => null;
  manager.inspectProviderRemote = async () => ({
    remoteFile: null,
    payload: null,
    remoteChanged: false,
  });
  manager.syncAllProviders = async (payload) => {
    uploads.push(structuredClone(payload));
    return new Map<CloudProvider, SyncResult>([
      ["webdav", { provider: "webdav", success: true, action: "upload" }],
    ]);
  };
  manager.setPendingLocalSync = () => {};
  manager.setAvailablePluginSyncProviders = () => {};
  const panel: MonitorPanel = {
    id: "p",
    name: "Fleet",
    description: "",
    hostIds: ["h1", "h2"],
    view: "charts",
    interval: 10,
    range: 15,
    sort: "manual",
    attentionOnly: false,
  };
  let api: ReturnType<typeof useAutoSync> | undefined;
  let renderer: ReactTestRenderer | undefined;
  const apply = async () => {};
  const Probe = () => {
    api = useAutoSync({
      hosts: [],
      keys: [],
      snippets: [],
      customGroups: ["fixture"],
      startupReady: true,
      onApplyPayload: apply,
      onApplyConvergentPayload: apply,
    });
    return null;
  };
  const waitForUpload = async (count: number) => {
    // Flush the adapter's batched event, then observe the actual debounced
    // upload. Slow CI must not be mistaken for an incomplete collection.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (uploads.length === count) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 3500));
      });
    } else {
      const deadline = Date.now() + 10000;
      while (uploads.length < count && Date.now() < deadline)
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
    }
    assert.equal(
      uploads.length,
      count,
      "a panel-only change must alter the auto-sync hash and upload",
    );
  };
  try {
    writeMonitorPanels([
      { ...panel, stats: { cpu: 42 }, points: [1], running: true },
    ]);
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await act(async () => {
      assert.equal(await api!.syncNow({ trigger: "manual" }), true);
    });
    assert.deepEqual(uploads[0].monitorPanels, [panel]);
    const renamed = { ...panel, name: "Renamed" };
    await act(async () => {
      await saveMonitorPanel(panel, renamed);
    });
    await waitForUpload(2);
    assert.deepEqual(uploads[1].monitorPanels, [renamed]);
    const edited = {
      ...renamed,
      hostIds: ["h2"],
      view: "list" as const,
      interval: 30 as const,
    };
    await act(async () => {
      await saveMonitorPanel(renamed, edited);
    });
    await waitForUpload(3);
    assert.deepEqual(uploads[2].monitorPanels, [edited]);
    await act(async () => {
      await deleteMonitorPanel(panel.id);
    });
    await waitForUpload(4);
    assert.deepEqual(uploads[3].monitorPanels, []);
    await act(async () => {
      await saveMonitorPanel(null, panel);
    });
    await waitForUpload(5);
    assert.deepEqual(uploads[4].monitorPanels, [panel]);
    assert.ok(
      uploads.every((p) => !JSON.stringify(p.monitorPanels).includes("stats")),
    );
    await act(async () => {
      await saveMonitorPanel(panel, panel);
    });
    await waitForUpload(5);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    Object.assign(manager, originals);
  }
});
