import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { removePaneVisible } from "./paneVisibilityStore.ts";
import { useTerminalHibernateEffect } from "./useTerminalHibernateEffect.ts";

test("hibernate effect keeps isVisibleRef current even when hibernate is disabled", () => {
  const source = readFileSync(
    new URL("./useTerminalHibernateEffect.ts", import.meta.url),
    "utf8",
  );
  // Visibility sync must not early-return when hibernate is off; otherwise
  // solo tab switches leave write/recovery paths on a stale isVisibleRef.
  assert.doesNotMatch(
    source,
    /if \(!hibernateEnabled\) \{\s*clearHibernateTimer\(\);[\s\S]*return \(\) => \{\s*unsubscribeDisabled\(\);\s*\};\s*\}/,
  );
  assert.match(source, /isVisibleRef\.current = visible;/);
  assert.match(
    source,
    /if \(hibernateEnabled\) \{\s*scheduleHibernate\(\);\s*\}/,
  );
});

test("disabling hibernate wakes already soft-hidden or hibernated panes", () => {
  const source = readFileSync(
    new URL("./useTerminalHibernateEffect.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /if \(!hibernateEnabled\) \{[\s\S]*?clearHibernateTimer\(\);[\s\S]*?if \(hibernatedRef\.current \|\| softHiddenRef\.current\) \{\s*tryWake\(\);\s*\}/,
  );
  // Must not early-return before visibility sync after the disable wake path.
  const disableWakeIndex = source.indexOf("Turning hibernate off must wake");
  const applyVisibilityCallIndex = source.indexOf(
    "applyVisibility(resolveVisible());",
    disableWakeIndex,
  );
  assert.ok(disableWakeIndex !== -1);
  assert.ok(applyVisibilityCallIndex !== -1);
  assert.ok(applyVisibilityCallIndex > disableWakeIndex);
});

test("soft-hidden wake keeps its marker until the runtime has resumed", () => {
  const source = readFileSync(
    new URL("./useTerminalHibernateEffect.ts", import.meta.url),
    "utf8",
  );
  const softWakeBranch = source.match(
    /if \(softHiddenRef\.current\) \{([\s\S]*?)return;\s*\}/,
  )?.[1] ?? "";

  assert.match(softWakeBranch, /onSoftHideWakeRef\.current\(\)/);
  assert.doesNotMatch(softWakeBranch, /softHiddenRef\.current\s*=\s*false/);
});

test("a keep-count of zero rechecks a soft-hidden tab while hibernate stays enabled", async (t) => {
  const sessionId = "keep-count-zero-recheck";
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousActEnvironment = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout, clearTimeout },
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  t.after(() => {
    removePaneVisible(sessionId);
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousActEnvironment) {
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
    } else {
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    }
  });

  let hibernateCalls = 0;
  let renderer: ReactTestRenderer | null = null;
  const softHiddenRef = { current: true };
  const ref = <T>(current: T) => ({ current });

  function Probe({ keepCount }: { keepCount: number }) {
    useTerminalHibernateEffect({
      sessionId,
      isVisible: false,
      isVisibleRef: ref(false),
      getSessionConnectedRef: ref(() => true),
      status: "connected",
      isSearchOpen: false,
      hibernateEnabled: true,
      hibernateDelayMs: 60_000,
      hibernateKeepRendererCount: keepCount,
      fileTransferActive: false,
      hibernatedRef: ref(false),
      softHiddenRef,
      hibernatePendingBufferRef: ref(""),
      hibernateSnapshotRef: ref(""),
      hibernateViewportSnapshotRef: ref(""),
      hibernateScrollbackSnapshotRef: ref(""),
      hibernateContextSnapshotRef: ref(""),
      hibernateContextViewportSnapshotRef: ref(""),
      hibernateContextScrollbackSnapshotRef: ref(""),
      hibernateAlternateScreenRef: ref(false),
      hasRuntimeRef: ref(true),
      onHibernate: () => { hibernateCalls += 1; },
      onSoftHideWake: () => {},
      onWake: () => true,
    });
    return null;
  }

  const element = (keepCount: number) => React.createElement(
    React.StrictMode,
    null,
    React.createElement(Probe, { keepCount }),
  );

  await act(async () => { renderer = create(element(2)); });
  assert.equal(hibernateCalls, 0, "a positive keep count must leave the retained runtime alone");

  await act(async () => { renderer!.update(element(1)); });
  assert.equal(hibernateCalls, 0, "a still-positive keep count must not drop every retained runtime");

  await act(async () => {
    renderer!.update(element(0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(hibernateCalls, 1, "zero retention must re-enter hibernate for a soft-hidden tab");

  await act(async () => renderer!.unmount());
});

test("hidden disconnected remote terminals release their retained runtime", async (t) => {
  const sessionId = "disconnected-hidden-hibernate-test";
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousActEnvironment = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout,
      clearTimeout,
    },
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  t.after(() => {
    removePaneVisible(sessionId);
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousActEnvironment) {
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
    } else {
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    }
  });

  let hibernateCalls = 0;
  let renderer: ReactTestRenderer | null = null;
  const ref = <T>(current: T) => ({ current });

  function Probe() {
    useTerminalHibernateEffect({
      sessionId,
      isVisible: false,
      isVisibleRef: ref(false),
      getSessionConnectedRef: ref(() => false),
      status: "disconnected",
      isSearchOpen: false,
      hibernateEnabled: true,
      hibernateDelayMs: 5,
      fileTransferActive: false,
      hibernatedRef: ref(false),
      softHiddenRef: ref(false),
      hibernatePendingBufferRef: ref(""),
      hibernateSnapshotRef: ref(""),
      hibernateViewportSnapshotRef: ref(""),
      hibernateScrollbackSnapshotRef: ref(""),
      hibernateContextSnapshotRef: ref(""),
      hibernateContextViewportSnapshotRef: ref(""),
      hibernateContextScrollbackSnapshotRef: ref(""),
      hibernateAlternateScreenRef: ref(false),
      hasRuntimeRef: ref(true),
      onHibernate: () => { hibernateCalls += 1; },
      onSoftHideWake: () => {},
      onWake: () => true,
    });
    return null;
  }

  await act(async () => { renderer = create(React.createElement(Probe)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  assert.equal(hibernateCalls, 1);
  await act(async () => renderer!.unmount());
});
