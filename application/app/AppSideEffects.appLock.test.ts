import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./AppSideEffects.tsx", import.meta.url), "utf8");

test("open-terminal requests wait behind App Lock and resume after unlock", () => {
  const handlerStart = source.indexOf("const _handleOpenTerminalPath");
  const handlerEnd = source.indexOf("useEffect(() =>", handlerStart);
  const handlerSource = source.slice(handlerStart, handlerEnd);
  const drainStart = source.indexOf("const pending = pendingDeepLinksWhileLockedRef.current.splice(0)");
  const drainEnd = source.indexOf("}, [appLockLocked]);", drainStart);
  const drainSource = source.slice(drainStart, drainEnd);

  assert.match(handlerSource, /shouldDeferExternalActionWhileAppLocked/);
  assert.match(handlerSource, /kind: 'open-terminal-path'/);
  assert.match(drainSource, /_processOpenTerminalPath\(item\.payload\)/);

  const processStart = source.indexOf("const _processOpenTerminalPath");
  const processSource = source.slice(processStart, handlerStart);
  assert.match(processSource, /handleCreateLocalTerminal\(undefined, \{ localStartDir \}\)/);
  assert.match(processSource, /resolveShellSetting\(shellSetting, shells\)/);
  assert.match(source, /const openTerminalQueueRef = useRef\(createOpenTerminalQueue\(\)\)/);
  const enqueueAt = processSource.indexOf("openTerminalQueueRef.current.enqueue(() => {");
  const createAt = processSource.indexOf("handleCreateLocalTerminal");
  assert.ok(enqueueAt >= 0 && createAt > enqueueAt);
  assert.match(processSource, /await ensureDiscoveredShells\(\)/);
});
