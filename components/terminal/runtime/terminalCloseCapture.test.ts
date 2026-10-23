import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  isTerminalCloseGenerationCurrent,
  resolveConnectionLogCapturePayload,
  resolveHibernateSnapshotCapturePayload,
  scheduleTerminalCloseTeardown,
  scheduleTerminalCloseForGeneration,
} from "./terminalCloseCapture.ts";

test("pending boot cleanup does not close a remounted terminal generation", async () => {
  let generation = 1;
  let closes = 0;
  scheduleTerminalCloseForGeneration(1, () => generation, () => { closes += 1; });
  generation = 2;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(closes, 0);
});

test("pending boot cleanup still closes a terminal that stays unmounted", async () => {
  let closes = 0;
  scheduleTerminalCloseForGeneration(1, () => 1, () => { closes += 1; });
  assert.equal(closes, 0);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(closes, 1);
});

test("resolveConnectionLogCapturePayload returns null when finalize produces empty data", () => {
  assert.equal(
    resolveConnectionLogCapturePayload(() => ""),
    null,
  );
});

test("resolveConnectionLogCapturePayload returns buffered connection log data", () => {
  assert.deepEqual(
    resolveConnectionLogCapturePayload(() => "line one\r\nline two"),
    { data: "line one\r\nline two", source: "connection-log" },
  );
});

test("resolveHibernateSnapshotCapturePayload prefers combined snapshot fields", () => {
  assert.deepEqual(
    resolveHibernateSnapshotCapturePayload({
      snapshot: "full snapshot",
      viewportSnapshot: "viewport",
      scrollbackSnapshot: "scrollback",
      alternateScreen: false,
    }),
    { data: "full snapshot", source: "hibernate-serialize" },
  );

  assert.deepEqual(
    resolveHibernateSnapshotCapturePayload({
      snapshot: "",
      viewportSnapshot: "viewport",
      scrollbackSnapshot: "scrollback",
      alternateScreen: false,
    }),
    { data: "scrollbackviewport", source: "hibernate-serialize" },
  );
});

test("scheduleTerminalCloseTeardown runs teardown asynchronously", async () => {
  let ran = false;
  scheduleTerminalCloseTeardown(() => {
    ran = true;
  });
  assert.equal(ran, false);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.equal(ran, true);
});

test("isTerminalCloseGenerationCurrent rejects stale close generations", () => {
  assert.equal(isTerminalCloseGenerationCurrent(1, 1), true);
  assert.equal(isTerminalCloseGenerationCurrent(1, 2), false);
});

test("terminal close fully drains pending output before finalizing capture", () => {
  const source = readFileSync(
    new URL("../useTerminalEffects.ts", import.meta.url),
    "utf8",
  );
  const cleanupStart = source.indexOf("return () => {", source.indexOf("void boot();"));
  const flushIndex = source.indexOf("await flushPendingTerminalWritesBeforeHibernate(term)", cleanupStart);
  const incompleteIndex = source.indexOf("if (!flushed)", flushIndex);
  const finalizeIndex = source.indexOf("resolveConnectionLogCapturePayload(finalizeTerminalLogData)", cleanupStart);

  assert.ok(cleanupStart >= 0);
  assert.ok(flushIndex > cleanupStart);
  assert.ok(incompleteIndex > flushIndex);
  assert.ok(finalizeIndex > flushIndex);
});

test("never-connected StrictMode cleanup sync-disposes its owned xterm runtime", () => {
  const source = readFileSync(
    new URL("../useTerminalEffects.ts", import.meta.url),
    "utf8",
  );
  const cleanupStart = source.indexOf("return () => {", source.indexOf("void boot();"));
  assert.ok(cleanupStart >= 0);
  const neverConnectedClose = source.indexOf(
    "if (!hasConnectedRef.current)",
    cleanupStart,
  );
  assert.ok(neverConnectedClose > cleanupStart);
  const branch = source.slice(
    neverConnectedClose,
    source.indexOf("const persistCloseCapture", neverConnectedClose),
  );
  assert.match(branch, /if \(!attachExistingSession\)/);
  assert.match(branch, /disposeOwnedRuntime\(\);/);
  assert.match(branch, /return;/);
  assert.ok(
    branch.indexOf("disposeOwnedRuntime();") < branch.indexOf("return;"),
    "orphaned StrictMode xterm must be disposed before leaving cleanup",
  );
});

test("createXTermRuntime clears orphaned .xterm children before open", () => {
  const source = readFileSync(
    new URL("./createXTermRuntime.ts", import.meta.url),
    "utf8",
  );
  const openAt = source.indexOf("term.open(ctx.container);");
  assert.ok(openAt > 0);
  const beforeOpen = source.slice(Math.max(0, openAt - 350), openAt);
  assert.match(beforeOpen, /querySelectorAll\(":scope > \.xterm"\)/);
  assert.match(beforeOpen, /orphan\.remove\(\)/);
});
