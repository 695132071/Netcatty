import test from "node:test";
import assert from "node:assert/strict";
import xterm from "@xterm/xterm";

import {
  nativeKittyKeyboardPreservesShiftEnter,
  readNativeKittyKeyboardFlags,
  SHIFT_ENTER_CSI_U_SEQUENCE,
} from "./shiftEnterText.ts";

const { Terminal } = xterm;

type KittyProbe = {
  flags: number;
  shiftEnter: string | undefined;
};

const probeShiftEnter = (setup: string): Promise<KittyProbe> => {
  const term = new Terminal({
    cols: 80,
    rows: 24,
    allowProposedApi: true,
    vtExtensions: { kittyKeyboard: true },
  });
  return new Promise((resolve) => {
    term.write(setup, () => {
      const event = {
        type: "keydown",
        key: "Enter",
        code: "Enter",
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        repeat: false,
        keyCode: 13,
      };
      const core = (term as unknown as {
        _core: {
          _keyboardService: {
            evaluateKeyDown: (ev: object) => { key?: string };
          };
        };
      })._core;
      resolve({
        flags: readNativeKittyKeyboardFlags(term),
        shiftEnter: core._keyboardService.evaluateKeyDown(event).key,
      });
    });
  });
};

test("xterm kitty keyboard encodes opted-in Shift+Enter as CSI 13;2u", async () => {
  const idle = await probeShiftEnter("");
  assert.equal(idle.flags, 0);
  assert.equal(idle.shiftEnter, "\r");
  assert.equal(nativeKittyKeyboardPreservesShiftEnter(idle.flags), false);

  const disambiguate = await probeShiftEnter("\u001b[=1u");
  assert.equal(disambiguate.flags, 1);
  assert.equal(disambiguate.shiftEnter, SHIFT_ENTER_CSI_U_SEQUENCE);
  assert.equal(nativeKittyKeyboardPreservesShiftEnter(disambiguate.flags), true);

  const alternateOnly = await probeShiftEnter("\u001b[=4u");
  assert.equal(alternateOnly.flags, 4);
  assert.equal(alternateOnly.shiftEnter, "\r");
  assert.equal(nativeKittyKeyboardPreservesShiftEnter(alternateOnly.flags), false);
});
