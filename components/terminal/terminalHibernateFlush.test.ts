import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readFunctionBody = (source: string, marker: string): string => {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} must exist`);

  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `${marker} must have a body`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart, index + 1);
      }
    }
  }

  assert.fail(`${marker} body must close`);
};

test("full hibernate flushes pending hidden output before taking the snapshot", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const body = readFunctionBody(source, "const fullHibernateRuntime = useCallback(async (): Promise<boolean> =>");

  const termCaptureIndex = body.indexOf("const term = termRef.current");
  const clearHiddenIndex = body.indexOf("terminalHiddenRendererStore.clearSoftHidden(sessionId)");
  const flushIndex = body.indexOf("flushPendingTerminalWritesBeforeHibernate(term)");
  const retryIndex = body.indexOf("scheduleHibernateRetry()");
  const alternateScreenSkipIndex = body.indexOf("shouldSkipHibernateForActiveAlternateScreen(term)");
  const snapshotIndex = body.indexOf("serializeTerminalForHibernate(");
  const releaseIndex = body.indexOf("releaseTerminalFlowBeforeHibernate(");

  assert.notEqual(termCaptureIndex, -1, "hibernate must capture the active terminal once");
  assert.notEqual(clearHiddenIndex, -1, "hibernate must clear hidden renderer state");
  assert.notEqual(flushIndex, -1, "hibernate must flush pending terminal writes completely");
  assert.notEqual(retryIndex, -1, "hibernate must retry when pending writes are still draining");
  assert.notEqual(alternateScreenSkipIndex, -1, "hibernate must re-check alternate screen after draining output");
  assert.notEqual(snapshotIndex, -1, "hibernate must serialize a terminal snapshot");
  assert.notEqual(releaseIndex, -1, "hibernate must release flow after snapshot");
  assert.ok(termCaptureIndex < flushIndex, "flush must use the captured terminal");
  assert.ok(clearHiddenIndex < flushIndex, "clear hidden state before flushing pending writes");
  assert.ok(flushIndex < retryIndex, "retry can only be scheduled after the drain attempt");
  assert.ok(retryIndex < snapshotIndex, "retry branch must happen before snapshot");
  assert.ok(flushIndex < alternateScreenSkipIndex, "alternate screen must be checked after pending writes are drained");
  assert.ok(retryIndex < alternateScreenSkipIndex, "retry branch must run before the alternate-screen re-check");
  assert.ok(alternateScreenSkipIndex < snapshotIndex, "alternate-screen skip must happen before snapshot");
  assert.ok(flushIndex < snapshotIndex, "flush pending writes before snapshot");
  assert.ok(snapshotIndex < releaseIndex, "release flow only after snapshot");
});

test("live context reads flush pending hidden output before reading the buffer", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const body = readFunctionBody(
    source,
    "const readTerminalContext = useCallback<TerminalContextReader>(async (request) =>",
  );

  const flushIndex = body.indexOf("await flushPendingTerminalWritesBeforeHibernate(targetTerm)");
  const drainGuardIndex = body.indexOf("if (!flushed)");
  const bufferReadIndex = body.indexOf("term.buffer.active");

  assert.notEqual(flushIndex, -1, "context reads must flush pending terminal writes");
  assert.notEqual(drainGuardIndex, -1, "context reads must reject an incomplete drain");
  assert.notEqual(bufferReadIndex, -1, "context reads must inspect the live terminal buffer");
  assert.ok(flushIndex < drainGuardIndex, "check the drain result after flushing");
  assert.ok(flushIndex < bufferReadIndex, "flush pending writes before reading the live buffer");
});

test("hibernate retry preserves normal hibernate blockers", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const body = readFunctionBody(source, "const scheduleHibernateRetry = useCallback(() =>");

  const searchBlockerIndex = body.indexOf("isSearchOpenRef.current");
  const transferBlockerIndex = body.indexOf("hibernateFileTransferActiveRef.current");
  const retryIndex = body.indexOf("fullHibernateRuntimeRef.current?.()");

  assert.notEqual(searchBlockerIndex, -1, "retry must skip hibernate while search is open");
  assert.notEqual(transferBlockerIndex, -1, "retry must skip hibernate while file transfer is active");
  assert.notEqual(retryIndex, -1, "retry must be able to resume hibernation");
  assert.ok(searchBlockerIndex < retryIndex, "search blocker must run before retrying hibernate");
  assert.ok(transferBlockerIndex < retryIndex, "file-transfer blocker must run before retrying hibernate");
});

test("full hibernate rechecks live state after every asynchronous step", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const body = readFunctionBody(source, "const fullHibernateRuntime = useCallback(async (): Promise<boolean> =>");

  const statusCaptureIndex = body.indexOf("const hibernateStatus = statusRef.current");
  const flushIndex = body.indexOf("await flushPendingTerminalWritesBeforeHibernate(term)");
  const afterFlushGuardIndex = body.indexOf("if (!canFinishHibernate()) return false;", flushIndex);
  const serializeIndex = body.indexOf("await serializeTerminalForHibernate(");
  const afterSerializeGuardIndex = body.indexOf("if (!canFinishHibernate()) return false;", serializeIndex);
  const releaseIndex = body.indexOf("releaseTerminalFlowBeforeHibernate(");

  assert.notEqual(statusCaptureIndex, -1, "hibernate must capture its starting lifecycle state");
  assert.match(body, /!isVisibleRef\.current/);
  assert.match(body, /hibernateEnabledRef\.current/);
  assert.match(body, /termRef\.current === term/);
  assert.match(body, /statusRef\.current === hibernateStatus/);
  assert.match(body, /sessionRef\.current === backendId/);
  assert.ok(statusCaptureIndex < flushIndex, "capture lifecycle state before the first await");
  assert.ok(flushIndex < afterFlushGuardIndex, "visibility and settings must be rechecked after draining output");
  assert.ok(afterFlushGuardIndex < serializeIndex, "the post-drain guard must run before serialization");
  assert.ok(serializeIndex < afterSerializeGuardIndex, "visibility and settings must be rechecked after serialization");
  assert.ok(afterSerializeGuardIndex < releaseIndex, "the final guard must run before releasing the live runtime");
});

test("ended hidden sessions release xterm without reopening dead backend listeners", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const fullHibernateBody = readFunctionBody(
    source,
    "const fullHibernateRuntime = useCallback(async (): Promise<boolean> =>",
  );
  const hibernateBody = readFunctionBody(source, "const hibernateRuntime = useCallback(() =>");

  assert.match(
    fullHibernateBody,
    /canHibernateTerminalRuntimeSession\(hibernateStatus, backendId\)/,
  );
  assert.match(
    fullHibernateBody,
    /statusRef\.current === hibernateStatus\s*&& sessionRef\.current === backendId/,
  );
  assert.match(
    fullHibernateBody,
    /const connectedBackendId = hibernateStatus === "connected" \? backendId : null;\s*if \(connectedBackendId\) \{\s*releaseTerminalFlowBeforeHibernate\([\s\S]*?connectedBackendId\);\s*\}\s*disposeDataRef\.current\?\.\(\);[\s\S]*?disposeRuntimeOnly\(\);\s*if \(connectedBackendId\) \{\s*beginHibernatedSessionListeners\(connectedBackendId\);\s*\}/,
  );
  assert.match(
    hibernateBody,
    /const keepCount = statusRef\.current === "connected"\s*\? resolveHibernateKeepRendererCount\(terminalSettings\)\s*: 0;/,
  );
});

test("reconnect preparation cancels an in-flight disconnected hibernate", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const fullHibernateBody = readFunctionBody(
    source,
    "const fullHibernateRuntime = useCallback(async (): Promise<boolean> =>",
  );
  const reconnectBody = readFunctionBody(
    source,
    'const startReconnect = async (mode: "manual" | "auto" = "manual") =>',
  );
  const startNewSessionBody = readFunctionBody(
    source,
    "const startNewSession = () =>",
  );
  const updateStatusBody = readFunctionBody(
    source,
    'const updateStatus = useCallback((next: TerminalSession["status"]) =>',
  );

  assert.match(
    fullHibernateBody,
    /reconnectPreparationTokenRef\.current === null/,
  );

  const claimIndex = reconnectBody.indexOf(
    "reconnectPreparationTokenRef.current = retryToken",
  );
  const cleanupIndex = reconnectBody.indexOf("await cleanupSession({ retainOwnership: true })");
  const startNewSessionIndex = reconnectBody.indexOf("const startNewSession = () =>");

  assert.ok(claimIndex >= 0 && claimIndex < cleanupIndex);
  assert.doesNotMatch(
    reconnectBody.slice(cleanupIndex, startNewSessionIndex),
    /reconnectPreparationTokenRef\.current = null/,
  );
  assert.match(
    startNewSessionBody,
    /if \(!retryStillActive\(\)\) \{\s*finishReconnectPreparation\(\);\s*return;\s*\}\s*finishReconnectPreparation\(\);/,
  );
  assert.match(
    reconnectBody,
    /term\.write\('\\x1b\[\?1049l', \(\) => \{\s*if \(!retryStillActive\(\)\) \{\s*finishReconnectPreparation\(\);\s*return;/,
  );
  assert.match(
    updateStatusBody,
    /statusRef\.current = next;\s*setStatus\(next\);/,
  );
});

test("ended soft-hidden and alternate-screen sessions can fully hibernate", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const fullHibernateBody = readFunctionBody(
    source,
    "const fullHibernateRuntime = useCallback(async (): Promise<boolean> =>",
  );
  const hibernateBody = readFunctionBody(
    source,
    "const hibernateRuntime = useCallback(() =>",
  );
  const alternateSkipBody = readFunctionBody(
    source,
    "const shouldSkipHibernateForActiveAlternateScreen = useCallback((term: XTerm): boolean =>",
  );

  assert.match(
    fullHibernateBody,
    /softHiddenRef\.current && statusRef\.current !== "disconnected"/,
  );
  assert.match(
    fullHibernateBody,
    /!softHiddenRef\.current \|\| hibernateStatus === "disconnected"/,
  );
  assert.match(
    hibernateBody,
    /if \(softHiddenRef\.current\) \{\s*const retainedKeepCount = statusRef\.current === "connected"\s*\? resolveHibernateKeepRendererCount\(terminalSettingsRef\.current\)\s*: 0;\s*if \(statusRef\.current === "disconnected" \|\| !\(retainedKeepCount > 0\)\) \{\s*upgradeSoftHiddenRuntimeToHibernate\(\);\s*\}\s*return;/,
  );
  assert.match(
    alternateSkipBody,
    /if \(statusRef\.current !== "connected"\) return false;/,
  );
});

test("a cancelled soft-hidden upgrade resumes its renderer", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const hibernateBody = readFunctionBody(source, "const hibernateRuntime = useCallback(() =>");
  const upgradeBody = readFunctionBody(source, "const upgradeSoftHiddenRuntimeToHibernate = useCallback(() =>");
  const helperBody = readFunctionBody(source, "const resumeRendererAfterCancelledHibernateUpgrade = useCallback(() =>");

  assert.match(
    hibernateBody,
    /if \(softHiddenRef\.current\) \{\s*const retainedKeepCount = statusRef\.current === "connected"\s*\? resolveHibernateKeepRendererCount\(terminalSettingsRef\.current\)\s*: 0;\s*if \(statusRef\.current === "disconnected" \|\| !\(retainedKeepCount > 0\)\) \{\s*upgradeSoftHiddenRuntimeToHibernate\(\);/,
  );
  const wakeIndex = upgradeBody.indexOf("wakeSoftHiddenRuntimeRef.current?.()");
  const upgradeIndex = upgradeBody.indexOf("fullHibernateRuntime().then(");
  const cancelResumeIndex = upgradeBody.indexOf("resumeRendererAfterCancelledHibernateUpgradeRef.current?.()", upgradeIndex);
  assert.notEqual(wakeIndex, -1, "every soft-hidden upgrade must resume the renderer before upgrading");
  assert.notEqual(upgradeIndex, -1, "soft-hidden upgrades must await the full hibernate result");
  assert.ok(wakeIndex < upgradeIndex, "the renderer must be live throughout the asynchronous upgrade");
  assert.notEqual(cancelResumeIndex, -1, "a cancelled upgrade must resume the renderer again");
  assert.match(helperBody, /ensureWebglRenderer\(\)/);
  assert.match(helperBody, /clearTextureAtlas\(\)/);
  assert.match(helperBody, /safeFitRef\.current\(\{ force: true \}\)/);
  const restoreGuard = "if (pendingEviction && !isVisibleRef.current && hibernateEnabledRef.current)";
  assert.equal(
    upgradeBody.split(restoreGuard).length - 1,
    2,
    "both the failed hibernate and the rejection path must skip soft-hide when the tab is visible or hibernate is off",
  );
  assert.ok(
    upgradeBody.indexOf(restoreGuard) > upgradeIndex,
    "the visibility guard belongs on the settled upgrade, after the renderer was resumed",
  );
});

test("snapshot and handoff paths reject output that misses the settle deadline", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");

  const drainWarningIndex = source.indexOf("Terminal output drain did not settle before the deadline");
  const drainReturnIndex = source.indexOf("return;", drainWarningIndex);
  const drainResponseIndex = source.indexOf("respondTerminalOutputDrain", drainReturnIndex);
  assert.ok(drainWarningIndex >= 0 && drainWarningIndex < drainReturnIndex);
  assert.ok(drainReturnIndex < drainResponseIndex);

  const snapshotWarningIndex = source.indexOf("Terminal snapshot drain did not settle before the deadline");
  const snapshotReturnIndex = source.indexOf("return;", snapshotWarningIndex);
  const snapshotSerializeIndex = source.indexOf("serializeAddonRef.current.serialize", snapshotReturnIndex);
  assert.ok(snapshotWarningIndex >= 0 && snapshotWarningIndex < snapshotReturnIndex);
  assert.ok(snapshotReturnIndex < snapshotSerializeIndex);

  const applyHandlerIndex = source.indexOf("onTerminalSessionApplySnapshot");
  const applyDrainIndex = source.indexOf("flushPendingTerminalWritesBeforeHibernate(term)", applyHandlerIndex);
  const applyFailureIndex = source.indexOf("Terminal output did not settle before applying the snapshot", applyDrainIndex);
  const applyMetadataIndex = source.indexOf("setKittyKeyboardProtocolEnabled", applyHandlerIndex);
  const applyResetIndex = source.indexOf("term.reset()", applyHandlerIndex);
  const applySnapshotWriteIndex = source.indexOf("term.write(payload.snapshot, resolve)", applyResetIndex);
  const applyCursorHighlightRefreshIndex = source.indexOf(
    "cursorLineHighlighter.refresh({ force: true })",
    applyResetIndex,
  );
  const applyScrollIndex = source.indexOf("term.scrollToBottom?.()", applyResetIndex);
  assert.ok(applyHandlerIndex >= 0 && applyHandlerIndex < applyDrainIndex);
  assert.ok(applyDrainIndex < applyFailureIndex);
  assert.ok(applyFailureIndex < applyMetadataIndex, "failed drains must not mutate snapshot metadata");
  assert.ok(applyMetadataIndex < applyResetIndex);
  assert.ok(applyResetIndex < applySnapshotWriteIndex);
  assert.ok(
    applySnapshotWriteIndex < applyCursorHighlightRefreshIndex,
    "cursor-line highlighting must refresh after applying an optional snapshot",
  );
  assert.ok(applyCursorHighlightRefreshIndex < applyScrollIndex);
  assert.match(
    source,
    /const flushed = await flushPendingTerminalWritesBeforeHibernate\(snapshotTerm\);\s*if \(!flushed\) \{\s*throw new Error\("Terminal output did not settle before closing the attached display"\);\s*\}/,
  );
});

test("a full keep count soft-hides the leaving session instead of snapshotting it", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const body = readFunctionBody(source, "const hibernateRuntime = useCallback(() =>");
  const imageGate = body.indexOf("if (runtimeHasInlineImages()) {");
  const alternateGate = body.indexOf("shouldSkipHibernateForActiveAlternateScreen(termRef.current)");
  const decision = body.indexOf("decideHiddenTabKeepCountAction(");
  const softHide = body.indexOf('if (keepDecision.action === "soft-hide")');
  const hide = body.indexOf("hideRuntimeOnly();", softHide);
  const full = body.indexOf("void fullHibernateRuntime()");

  assert.ok(alternateGate !== -1 && alternateGate < imageGate);
  assert.ok(imageGate !== -1 && imageGate < decision);
  assert.ok(decision < softHide && softHide < hide && hide < full);
  const awaited = body.indexOf("retainLeavingTabAfterEviction({");
  assert.ok(awaited > decision, "a full keep set retains the leaving tab from the application eviction walk");
  assert.match(body, /getSoftHiddenOccupancy\(\)/);
  assert.match(body, /stillWantsRetention:/);
  assert.match(body, /softHide: \(\) => hideRuntimeOnly\(\)/);
  assert.match(
    body,
    /resolveKeepCount: \(\) => \(\s*statusRef\.current === "connected"\s*\? resolveHibernateKeepRendererCount\(terminalSettingsRef\.current\)\s*: 0\s*\)/,
    "retention after eviction must read the live keep count, not the captured one",
  );
  assert.doesNotMatch(body, /resolveHiddenTabEviction/);
  assert.doesNotMatch(body, /requestEviction\(keepDecision/);
  assert.match(
    body,
    /if \(softHiddenRef\.current\) \{\s*const retainedKeepCount = statusRef\.current === "connected"\s*\? resolveHibernateKeepRendererCount\(terminalSettingsRef\.current\)\s*: 0;\s*if \(statusRef\.current === "disconnected" \|\| !\(retainedKeepCount > 0\)\) \{\s*upgradeSoftHiddenRuntimeToHibernate\(\);\s*\}\s*return;\s*\}/,
  );
});
