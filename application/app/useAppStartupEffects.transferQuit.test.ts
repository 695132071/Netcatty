import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useAppStartupEffects } from "./useAppStartupEffects.ts";
import { sftpTransferCenterStore } from "../state/sftpTransferCenterStore.ts";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge.ts";

for (const accept of [false, true]) {
  test(`app Quit with an unfinished transfer: ${accept ? "confirm quits" : "declining reports \"transfers\" before resuming only transferring and queued tasks"}`, async (t) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    const g = globalThis as unknown as { window?: { confirm?: (m: string) => boolean } };
    const hadWindow = "window" in g; const previousConfirm = g.window?.confirm;
    if (!g.window) g.window = {};
    g.window.confirm = () => accept;
    let renderer: ReactTestRenderer | undefined;
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
    t.after(async () => {
      releaseResume();
      await act(async () => renderer?.unmount());
      if (hadWindow && g.window) g.window.confirm = previousConfirm; else delete g.window;
      if (previous) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
      else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    });
    const calls: string[] = [];
    const reports: Array<[boolean, string | undefined]> = [];
    let resumeSettled = false;
    let query!: () => Promise<void>;
    t.mock.method(sftpTransferCenterStore, "getSnapshot", () => ({
      tasks: [
        { id: "running", status: "transferring" },
        { id: "queued", status: "queued" },
        { id: "already-paused", status: "paused" },
        { id: "pausing", status: "pausing" },
        { id: "interrupted", status: "interrupted" },
        { id: "child", parentTaskId: "running", status: "transferring" },
      ],
    }) as unknown as ReturnType<typeof sftpTransferCenterStore.getSnapshot>);
    t.mock.method(sftpTransferCenterStore, "pause", async (id: string) => { calls.push(`pause:${id}`); });
    t.mock.method(sftpTransferCenterStore, "resume", async (id: string) => {
      calls.push(`resume:${id}`);
      await resumeGate;
      resumeSettled = true;
    });
    t.mock.method(netcattyBridge, "get", () => ({
      onCheckDirtyEditors: (callback: typeof query) => { query = callback; return () => {}; },
      reportDirtyEditorsResult: (dirty: boolean, reason?: string) => {
        calls.push("report");
        reports.push([dirty, reason]);
      },
    }));
    function Probe() {
      useAppStartupEffects({ enabled: false, updateState: {}, sessions: [], hosts: [], keys: [], identities: [], knownHosts: [], proxyProfiles: [], groupConfigs: [], workspaces: [], portForwardingRules: [], t: (key: string) => key });
      return null;
    }
    await act(async () => { renderer = create(React.createElement(Probe)); });
    const paused = [
      "pause:running",
      "pause:queued",
      "pause:already-paused",
      "pause:pausing",
      "pause:interrupted",
    ];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        query(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("dirty check waited on resume")), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(resumeSettled, false, "the dirty-check reply must not wait for resume");
    if (accept) {
      assert.deepEqual(reports, [[false, undefined]]);
      assert.deepEqual(calls, [...paused, "report"], "accepted quit leaves every prompted task paused");
    } else {
      assert.deepEqual(reports, [[true, "transfers"]], "main must be told the prompt was already answered");
      assert.deepEqual(calls, [...paused, "report", "resume:running", "resume:queued"],
        "report precedes resume, and only transferring/queued rows the prompt paused are resumed");
    }
  });
}
