import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { shouldBroadcastTerminalUserInput } from "./terminalUserPaste.ts";

test("toolbar broadcast still fans terminal keystrokes out to peers", () => {
  const term = {};
  assert.equal(
    shouldBroadcastTerminalUserInput(term, "ls", {
      isBroadcastEnabled: true,
      hasBroadcastInputHandler: true,
    }),
    true,
  );
  assert.equal(
    shouldBroadcastTerminalUserInput(term, "ls", {
      isBroadcastEnabled: false,
      hasBroadcastInputHandler: true,
    }),
    false,
  );
});

test("keystroke fan-out stays on the toolbar gate and ignores the compose-bar target", () => {
  const runtime = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
  assert.match(runtime, /isBroadcastEnabled: ctx\.isBroadcastEnabledRef\.current/);
  assert.match(
    runtime,
    /onBroadcastInput\?\.\(broadcastData, ctx\.sessionId, sensitive \? \{ sourceSensitive: true \} : undefined\)/,
  );
  assert.doesNotMatch(runtime, /composeSendToAll|composePeerFanOut/);

  const layer = readFileSync(new URL("../../TerminalLayer.tsx", import.meta.url), "utf8");
  assert.match(layer, /includeGlobalPeersWithoutToolbar: options\?\.composePeerFanOut === true/);
  const keystrokeCall = layer.slice(
    layer.indexOf("const handleBroadcastInput"),
    layer.indexOf("const handleCommandSubmitted"),
  );
  assert.doesNotMatch(keystrokeCall, /isComposeSendToAll/);
});
