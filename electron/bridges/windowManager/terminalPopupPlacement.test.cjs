"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { intersects, placeTerminalPopup } = require("./terminalPopupPlacement.cjs");

const workArea = { x: 0, y: 0, width: 1440, height: 900 };
const sourceBounds = { x: 0, y: 0, width: 1440, height: 900 };

test("a popup beside a right-side panel does not cover the panel", () => {
  const avoid = { x: 1000, y: 40, width: 440, height: 860 };
  const frame = placeTerminalPopup({
    workArea,
    sourceBounds,
    avoid,
    width: 920,
    height: 580,
  });

  assert.equal(intersects(frame, avoid), false);
  assert.ok(frame.x + frame.width <= avoid.x);
  assert.equal(frame.width, 920);
  assert.equal(frame.height, 580);
});

test("a popup beside a left-side panel stays in the remaining terminal area", () => {
  const avoid = { x: 0, y: 36, width: 420, height: 864 };
  const frame = placeTerminalPopup({
    workArea,
    sourceBounds,
    avoid,
    width: 920,
    height: 580,
  });

  assert.equal(intersects(frame, avoid), false);
  assert.ok(frame.x >= avoid.x + avoid.width);
});

test("a popup above a bottom dock does not cover the dock", () => {
  const avoid = { x: 0, y: 620, width: 1440, height: 280 };
  const frame = placeTerminalPopup({
    workArea,
    sourceBounds,
    avoid,
    width: 920,
    height: 580,
  });

  assert.equal(intersects(frame, avoid), false);
  assert.ok(frame.y + frame.height <= avoid.y);
});

test("a popup for an off-screen source stays in the work area and off the panel", () => {
  const avoid = { x: 500, y: 0, width: 440, height: 900 };
  const frame = placeTerminalPopup({
    workArea,
    sourceBounds: { x: -500, y: 0, width: 1440, height: 900 },
    avoid,
    width: 920,
    height: 580,
  });

  assert.equal(intersects(frame, avoid), false);
  assert.ok(frame.x >= workArea.x);
  assert.ok(frame.y >= workArea.y);
  assert.ok(frame.x + frame.width <= workArea.x + workArea.width);
  assert.ok(frame.y + frame.height <= workArea.y + workArea.height);
  assert.ok(frame.width >= 480);
  assert.ok(frame.height >= 320);
});
