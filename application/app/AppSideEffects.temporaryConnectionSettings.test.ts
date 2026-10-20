import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./AppSideEffects.tsx", import.meta.url), "utf8");

test("handleConnectToHost reads temporary connection settings at call time", () => {
  assert.match(source, /const temporaryConnectionSettingsRef = useRef\(terminalSettings\)/);
  assert.match(source, /temporaryConnectionSettingsRef\.current = terminalSettings/);

  const handlerStart = source.indexOf("const handleConnectToHost = useCallback");
  const handlerEnd = source.indexOf("const handleConnectToHostWithTabName");
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);

  assert.match(handler, /temporaryConnectionSettingsRef\.current/);
  assert.match(handler, /temporaryConnectionPrepareOptions\(liveTerminalSettings\)/);
  assert.match(handler, /terminalSettings: liveTerminalSettings/);
  assert.doesNotMatch(handler, /terminalSettings\.temporaryConnections/);
  assert.doesNotMatch(handler, /\[addConnectionLog, connectToHost, resolveEffectiveHost, identities, keys, discoveredShells, terminalSettings\]/);
});
