import assert from "node:assert/strict";
import test from "node:test";

import {
  attachWindowResizeFocusRestore,
  WINDOW_RESIZE_RESTORE_FOCUS_DELAY_MS,
  type MinimalDocument,
} from "./restoreWindowResizeFocus";

type FakeWindow = {
  listeners: Map<string, Array<() => void>>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  emit: (type: string) => void;
};

const createWindowStub = (): FakeWindow => {
  const listeners = new Map<string, Array<() => void>>();
  return {
    listeners,
    addEventListener(type, listener) {
      const bucket = listeners.get(type) ?? [];
      bucket.push(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      const bucket = listeners.get(type) ?? [];
      const index = bucket.indexOf(listener);
      if (index >= 0) bucket.splice(index, 1);
    },
    emit(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
  };
};

type SchedulerState = {
  schedule: (callback: () => void, delay: number) => number;
  cancel: (id: number) => void;
  runNext: () => void;
  pendingCount: () => number;
};

const createScheduler = (): SchedulerState => {
  type Entry = { id: number; callback: () => void; cancelled: boolean };
  const queue: Entry[] = [];
  let nextId = 1;
  return {
    schedule(callback, delay) {
      assert.equal(delay, WINDOW_RESIZE_RESTORE_FOCUS_DELAY_MS);
      queue.push({ id: nextId, callback, cancelled: false });
      return nextId++;
    },
    cancel(id) {
      for (const entry of queue) {
        if (entry.id === id) entry.cancelled = true;
      }
    },
    runNext() {
      while (queue.length) {
        const entry = queue.shift()!;
        if (!entry.cancelled) {
          entry.callback();
          return;
        }
      }
    },
    pendingCount: () => queue.filter((entry) => !entry.cancelled).length,
  };
};

test("resize restores terminal focus once the resize settles", () => {
  const win = createWindowStub();
  const scheduler = createScheduler();
  let refocusCalls = 0;
  const detach = attachWindowResizeFocusRestore({
    win,
    doc: { querySelector: () => null, hasFocus: () => true } as MinimalDocument,
    refocus: () => { refocusCalls += 1; },
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
  });

  win.emit("resize");
  assert.equal(scheduler.pendingCount(), 1, "restore must be debounced");
  assert.equal(refocusCalls, 0);
  scheduler.runNext();
  assert.equal(refocusCalls, 1);

  detach();
});

test("a continuous frame drag only triggers one restore", () => {
  const win = createWindowStub();
  const scheduler = createScheduler();
  let refocusCalls = 0;
  const detach = attachWindowResizeFocusRestore({
    win,
    doc: { querySelector: () => null, hasFocus: () => true } as MinimalDocument,
    refocus: () => { refocusCalls += 1; },
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
  });

  win.emit("resize");
  win.emit("resize");
  win.emit("resize");
  scheduler.runNext();
  assert.equal(refocusCalls, 1, "debounced resizes must collapse into one restore");

  detach();
});

test("resize does not steal focus when the app window is not focused", () => {
  const win = createWindowStub();
  const scheduler = createScheduler();
  let refocusCalls = 0;
  const detach = attachWindowResizeFocusRestore({
    win,
    doc: { querySelector: () => null, hasFocus: () => false } as MinimalDocument,
    refocus: () => { refocusCalls += 1; },
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
  });

  win.emit("resize");
  scheduler.runNext();
  assert.equal(refocusCalls, 0);

  detach();
});

test("resize restore is skipped while a modal dialog is open", () => {
  const win = createWindowStub();
  const scheduler = createScheduler();
  let refocusCalls = 0;
  const detach = attachWindowResizeFocusRestore({
    win,
    doc: {
      querySelector: (selector: string) => (
        selector === '[role="dialog"][data-state="open"]' ? {} : null
      ),
      hasFocus: () => true,
    } as MinimalDocument,
    refocus: () => { refocusCalls += 1; },
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
  });

  win.emit("resize");
  scheduler.runNext();
  assert.equal(refocusCalls, 0);

  detach();
});

test("resize does not steal focus from an active editable field", () => {
  const win = createWindowStub();
  const scheduler = createScheduler();
  let refocusCalls = 0;
  const detach = attachWindowResizeFocusRestore({
    win,
    doc: {
      querySelector: () => null,
      hasFocus: () => true,
      activeElement: { tagName: "INPUT", matches: () => false },
    } as unknown as MinimalDocument,
    refocus: () => { refocusCalls += 1; },
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
  });

  win.emit("resize");
  scheduler.runNext();
  assert.equal(refocusCalls, 0, "restore must not yank focus out of an editable field");

  detach();
});

test("resize does not steal focus from a contenteditable field", () => {
  const win = createWindowStub();
  const scheduler = createScheduler();
  let refocusCalls = 0;
  const detach = attachWindowResizeFocusRestore({
    win,
    doc: {
      querySelector: () => null,
      hasFocus: () => true,
      activeElement: { tagName: "DIV", isContentEditable: true, matches: () => false },
    } as unknown as MinimalDocument,
    refocus: () => { refocusCalls += 1; },
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
  });

  win.emit("resize");
  scheduler.runNext();
  assert.equal(refocusCalls, 0);

  detach();
});

test("resize still restores while the xterm helper textarea is focused", () => {
  const win = createWindowStub();
  const scheduler = createScheduler();
  let refocusCalls = 0;
  const detach = attachWindowResizeFocusRestore({
    win,
    doc: {
      querySelector: () => null,
      hasFocus: () => true,
      activeElement: {
        tagName: "TEXTAREA",
        matches: (selector: string) => selector === "textarea.xterm-helper-textarea",
      },
    } as unknown as MinimalDocument,
    refocus: () => { refocusCalls += 1; },
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
  });

  win.emit("resize");
  scheduler.runNext();
  assert.equal(refocusCalls, 1, "terminal-owned focus must be restored after resize");

  detach();
});

test("detach removes the listener and cancels a pending restore", () => {
  const win = createWindowStub();
  const scheduler = createScheduler();
  let refocusCalls = 0;
  const detach = attachWindowResizeFocusRestore({
    win,
    doc: { querySelector: () => null, hasFocus: () => true } as MinimalDocument,
    refocus: () => { refocusCalls += 1; },
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
  });

  win.emit("resize");
  detach();

  assert.equal((win.listeners.get("resize") ?? []).length, 0, "listener must be removed");
  assert.equal(scheduler.pendingCount(), 0, "pending restore must be cancelled");
  scheduler.runNext();
  assert.equal(refocusCalls, 0);
});

test("a win without listener support degrades to a no-op detach", () => {
  const detach = attachWindowResizeFocusRestore({
    win: null,
    refocus: () => {},
    scheduleTimeout: () => 1,
    cancelTimeout: () => {},
  });
  assert.doesNotThrow(() => detach());
});
