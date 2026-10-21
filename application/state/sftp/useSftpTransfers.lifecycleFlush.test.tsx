/** @test lifecycle repaints coalesce to one frame and still settle the final status */
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { TransferTask } from "../../../domain/models";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";
import { latchTransferPauseTree, releaseTransferPauseTree } from "./transferPauseLatch";
import { useSftpTransfers } from "./useSftpTransfers";

type Frame = { id: number; callback: (time: number) => void; cancelled: boolean };

function installFrameQueue() {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousActFlag = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const frames: Frame[] = [];
  let nextId = 1;
  const requestAnimationFrame = (callback: (time: number) => void) => {
    const frame: Frame = { id: nextId++, callback, cancelled: false };
    frames.push(frame);
    return frame.id;
  };
  const cancelAnimationFrame = (id: number) => {
    const frame = frames.find((candidate) => candidate.id === id);
    if (frame) frame.cancelled = true;
  };
  (globalThis as { window?: unknown }).window = {
    netcatty: {},
    requestAnimationFrame,
    cancelAnimationFrame,
  };
  return {
    frames,
    flush: async () => {
      const pending = frames.splice(0, frames.length).filter((frame) => !frame.cancelled);
      await act(async () => {
        for (const frame of pending) frame.callback(0);
      });
      return pending.length;
    },
    restore: () => {
      (globalThis as { window?: unknown }).window = previousWindow;
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActFlag;
    },
  };
}

function makeTask(id: string, status: TransferTask["status"], error?: string): TransferTask {
  return {
    id,
    fileName: `${id}.txt`,
    sourcePath: `/source/${id}.txt`,
    targetPath: `/target/${id}.txt`,
    sourceConnectionId: "local",
    targetConnectionId: "remote",
    direction: "upload",
    status,
    error,
    totalBytes: 10,
    transferredBytes: status === "completed" ? 10 : 2,
    speed: status === "transferring" ? 1 : 0,
    startTime: 1,
    isDirectory: false,
    resumable: true,
  };
}

function mount(ownerId: string) {
  let ops: ReturnType<typeof useSftpTransfers> | undefined;
  let renderer: ReactTestRenderer | undefined;
  function Probe() {
    ops = useSftpTransfers({
      ownerId,
      getActivePane: () => null,
      getPaneByConnectionId: () => null,
      getTabByConnectionId: () => null,
      updateTab: () => undefined,
      refresh: async () => undefined,
      clearCacheForConnection: () => undefined,
      handleSessionError: () => undefined,
      sftpSessionsRef: { current: new Map() },
      connectionCacheKeyMapRef: { current: new Map() },
      listLocalFiles: async () => [],
      listRemoteFiles: async () => [],
    });
    return null;
  }
  return {
    get ops() {
      return ops;
    },
    render: async () => {
      await act(async () => { renderer = create(React.createElement(Probe)); });
    },
    unmount: async () => {
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
    },
  };
}

test("lifecycle frames keep the final completion, pause, cancel, and error status", async () => {
  const ownerId = "lifecycle-flush-final-status";
  const queue = installFrameQueue();
  const view = mount(ownerId);
  const taskId = "lifecycle-row";
  try {
    await view.render();
    const stages: Array<{ status: TransferTask["status"]; error?: string }> = [
      { status: "transferring" },
      { status: "paused" },
      { status: "cancelled" },
      { status: "failed", error: "connection reset" },
      { status: "completed" },
    ];
    for (const stage of stages) {
      await act(async () => {
        sftpTransferCenterStore.publishOwner(ownerId, [makeTask(taskId, stage.status, stage.error)]);
      });
      const paintsNow = stage.status !== "transferring";
      if (paintsNow) {
        assert.equal(queue.frames.filter((frame) => !frame.cancelled).length, 0);
      } else {
        assert.notEqual(view.ops?.transfers.find((row) => row.id === taskId)?.status, stage.status);
        assert.equal(queue.frames.filter((frame) => !frame.cancelled).length, 1);
        assert.equal(await queue.flush(), 1);
      }
      const painted = view.ops?.transfers.find((row) => row.id === taskId);
      assert.equal(painted?.status, stage.status);
      assert.equal(painted?.error, stage.error);
      assert.equal(
        sftpTransferCenterStore.getOwnerTasks(ownerId).find((row) => row.id === taskId)?.status,
        stage.status,
      );
    }
  } finally {
    sftpTransferCenterStore.dismiss(taskId);
    await view.unmount();
    queue.restore();
  }
});

test("parent pause paints while a child frame is pending and a stale publish cannot reopen it", async () => {
  const ownerId = "lifecycle-flush-parent-pause";
  const queue = installFrameQueue();
  const view = mount(ownerId);
  const parentId = "folder-parent";
  const childId = "folder-child";
  const parent = (status: TransferTask["status"]): TransferTask => ({
    ...makeTask(parentId, status),
    isDirectory: true,
    progressMode: "files",
    lifecycleEpoch: 4,
  });
  const child = (status: TransferTask["status"]): TransferTask => ({
    ...makeTask(childId, status),
    parentTaskId: parentId,
    lifecycleEpoch: 4,
  });
  try {
    await view.render();
    sftpTransferCenterStore.publishOwner(ownerId, [parent("transferring"), child("transferring")]);
    assert.equal(view.ops?.transfers.length, 0, "child lifecycle churn stays on the pending frame");
    assert.equal(queue.frames.filter((frame) => !frame.cancelled).length, 1);

    // Pause lands while that frame is still queued. Latch afterwards: the
    // control-epoch guard drops a panel publish that arrives already latched,
    // and Resume is the equal-epoch republish that happens only after unlatch.
    await act(async () => {
      sftpTransferCenterStore.publishOwner(ownerId, [parent("paused"), child("paused")]);
    });
    assert.equal(view.ops?.transfers.find((row) => row.id === parentId)?.status, "paused");
    assert.equal(view.ops?.transfers.find((row) => row.id === childId)?.status, "paused");
    assert.equal(queue.frames.filter((frame) => !frame.cancelled).length, 0, "pause cancels the pre-pause frame");

    latchTransferPauseTree(parentId, [childId]);
    await act(async () => {
      sftpTransferCenterStore.publishOwner(ownerId, [parent("transferring"), child("paused")]);
    });
    await queue.flush();
    assert.equal(sftpTransferCenterStore.getTask(parentId)?.status, "paused");
    assert.equal(sftpTransferCenterStore.getTask(childId)?.status, "paused");
    const paintedParent = view.ops?.transfers.find((row) => row.id === parentId);
    assert.equal(paintedParent?.status, "paused");
    assert.equal(
      view.ops?.transfers.filter((row) => (
        !row.parentTaskId && ["pending", "queued", "transferring", "pausing"].includes(row.status)
      )).length,
      0,
    );
  } finally {
    releaseTransferPauseTree(parentId, [childId]);
    sftpTransferCenterStore.dismiss(parentId);
    await view.unmount();
    queue.restore();
  }
});

test("unmount cancels the pending lifecycle frame and remount reads the settled store row", async () => {
  const ownerId = "lifecycle-flush-unmount";
  const queue = installFrameQueue();
  const view = mount(ownerId);
  const taskId = "lifecycle-unmount-row";
  try {
    await view.render();
    sftpTransferCenterStore.publishOwner(ownerId, [makeTask(taskId, "failed", "write failed")]);
    assert.equal(view.ops?.transfers.length, 0);
    assert.equal(queue.frames.filter((frame) => !frame.cancelled).length, 1);

    await view.unmount();
    assert.equal(queue.frames.filter((frame) => !frame.cancelled).length, 0);
    assert.equal(await queue.flush(), 0);

    await view.render();
    const painted = view.ops?.transfers.find((row) => row.id === taskId);
    assert.equal(painted?.status, "failed");
    assert.equal(painted?.error, "write failed");
    assert.equal(queue.frames.filter((frame) => !frame.cancelled).length, 0);
  } finally {
    sftpTransferCenterStore.dismiss(taskId);
    await view.unmount();
    queue.restore();
  }
});
