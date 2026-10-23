import test from "node:test";
import assert from "node:assert/strict";
import type React from "react";

import {
  MIDDLE_MOUSE_BUTTON,
  TAB_DRAG_THRESHOLD_PX,
  handleTabCloseButtonMouseDown,
  handleTabDragThresholdDrag,
  handleTabDragThresholdDragStart,
  handleTabDragThresholdMouseDown,
  handleTabDragThresholdRelease,
  handleTabDragThresholdReset,
  isTabDragReorderStarted,
  handleTabMiddleClickClose,
  handleTabMiddleMouseDown,
} from "./tabInteractions.ts";

interface FakeMouseEvent {
  button: number;
  clientX: number;
  clientY: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

const makeEvent = (button: number, clientX = 0, clientY = 0) => {
  const calls = { preventDefault: 0, stopPropagation: 0 };
  const event = {
    button,
    clientX,
    clientY,
    preventDefault: () => {
      calls.preventDefault++;
    },
    stopPropagation: () => {
      calls.stopPropagation++;
    },
  } satisfies FakeMouseEvent;
  return { event: event as unknown as React.MouseEvent, calls };
};

const beginPrimaryPress = (clientX: number, clientY: number) => {
  const press = makeEvent(0, clientX, clientY);
  handleTabDragThresholdMouseDown(press.event);
  return press;
};

test("handleTabMiddleClickClose closes the tab on a middle click", () => {
  let closed = 0;
  const { event, calls } = makeEvent(MIDDLE_MOUSE_BUTTON);

  handleTabMiddleClickClose(event, () => {
    closed++;
  });

  assert.equal(closed, 1);
  assert.equal(calls.preventDefault, 1);
  assert.equal(calls.stopPropagation, 1);
});

test("handleTabMiddleClickClose ignores left and right clicks", () => {
  for (const button of [0, 2]) {
    let closed = 0;
    const { event, calls } = makeEvent(button);

    handleTabMiddleClickClose(event, () => {
      closed++;
    });

    assert.equal(closed, 0, `button ${button} must not close the tab`);
    assert.equal(calls.preventDefault, 0);
  }
});

test("handleTabMiddleMouseDown suppresses autoscroll only for the middle button", () => {
  const middle = makeEvent(MIDDLE_MOUSE_BUTTON);
  handleTabMiddleMouseDown(middle.event);
  assert.equal(middle.calls.preventDefault, 1);

  const left = makeEvent(0);
  handleTabMiddleMouseDown(left.event);
  assert.equal(left.calls.preventDefault, 0);
});

test("sub-threshold dragstart does not cancel the gesture, and mouseup activates", () => {
  handleTabDragThresholdReset();
  for (const distance of [0, TAB_DRAG_THRESHOLD_PX - 1]) {
    const press = beginPrimaryPress(10, 20);
    assert.equal(press.calls.preventDefault, 0, "primary mousedown must still allow a later drag");

    const drag = makeEvent(0, 10 + distance, 20);
    const skipReorder = handleTabDragThresholdDragStart(drag.event as unknown as React.DragEvent);
    assert.equal(skipReorder, true, `distance ${distance} must not start a reorder`);
    assert.equal(isTabDragReorderStarted(), false, `distance ${distance} must not arm reorder chrome`);
    assert.equal(drag.calls.preventDefault, 0, `distance ${distance} must not preventDefault`);

    let activated = 0;
    const release = makeEvent(0, 10 + distance, 20);
    handleTabDragThresholdRelease(release.event, () => {
      activated++;
    });
    assert.equal(activated, 1, `distance ${distance} must activate on mouseup`);
    assert.equal(release.calls.preventDefault, 0);
  }
  handleTabDragThresholdReset();
});

test("a sub-threshold release activates only once when mouseup and dragend both fire", () => {
  handleTabDragThresholdReset();
  beginPrimaryPress(4, 4);
  const drag = makeEvent(0, 6, 4);
  assert.equal(handleTabDragThresholdDragStart(drag.event as unknown as React.DragEvent), true);

  let activated = 0;
  const activate = () => {
    activated++;
  };
  handleTabDragThresholdRelease(makeEvent(0, 6, 4).event, activate);
  handleTabDragThresholdRelease(makeEvent(0, 6, 4).event, activate);
  assert.equal(activated, 1);
  handleTabDragThresholdReset();
});

test("mouseup without dragstart does not activate", () => {
  handleTabDragThresholdReset();
  beginPrimaryPress(1, 1);
  let activated = 0;
  handleTabDragThresholdRelease(makeEvent(0, 2, 1).event, () => {
    activated++;
  });
  assert.equal(activated, 0);
  handleTabDragThresholdReset();
});

test("drags at or above the threshold still reorder and do not activate on release", () => {
  handleTabDragThresholdReset();
  for (const distance of [TAB_DRAG_THRESHOLD_PX, TAB_DRAG_THRESHOLD_PX + 12]) {
    beginPrimaryPress(5, 8);
    const drag = makeEvent(0, 5 + distance, 8);
    const skipReorder = handleTabDragThresholdDragStart(drag.event as unknown as React.DragEvent);
    assert.equal(skipReorder, false, `distance ${distance} must keep the reorder drag`);
    assert.equal(isTabDragReorderStarted(), true, `distance ${distance} must arm reorder chrome`);
    assert.equal(drag.calls.preventDefault, 0, `distance ${distance} must not preventDefault`);
    assert.equal(handleTabDragThresholdDrag(drag.event as unknown as React.DragEvent), false);

    let activated = 0;
    handleTabDragThresholdRelease(makeEvent(0, 5 + distance, 8).event, () => {
      activated++;
    });
    assert.equal(activated, 0, `distance ${distance} must not fake-activate`);
  }
  handleTabDragThresholdReset();
});

test("a slow drag that starts under the threshold reorders once it crosses it", () => {
  handleTabDragThresholdReset();
  beginPrimaryPress(0, 0);
  const dragStart = makeEvent(0, TAB_DRAG_THRESHOLD_PX - 1, 0);
  assert.equal(
    handleTabDragThresholdDragStart(dragStart.event as unknown as React.DragEvent),
    true,
  );
  assert.equal(dragStart.calls.preventDefault, 0);

  const stillShort = makeEvent(0, TAB_DRAG_THRESHOLD_PX - 1, 0);
  assert.equal(handleTabDragThresholdDrag(stillShort.event as unknown as React.DragEvent), false);

  const crossed = makeEvent(0, TAB_DRAG_THRESHOLD_PX, 0);
  assert.equal(isTabDragReorderStarted(), false);
  assert.equal(handleTabDragThresholdDrag(crossed.event as unknown as React.DragEvent), true);
  assert.equal(isTabDragReorderStarted(), true);
  assert.equal(handleTabDragThresholdDrag(crossed.event as unknown as React.DragEvent), false);

  let activated = 0;
  handleTabDragThresholdRelease(makeEvent(0, 1, 0).event, () => {
    activated++;
  });
  assert.equal(activated, 0, "returning near the origin after a real drag must not activate");
  handleTabDragThresholdReset();
});

test("handleTabDragThreshold ignores non-primary buttons", () => {
  handleTabDragThresholdReset();
  for (const button of [MIDDLE_MOUSE_BUTTON, 2]) {
    const press = makeEvent(button, 4, 6);
    handleTabDragThresholdMouseDown(press.event);
    assert.equal(
      press.calls.preventDefault,
      button === MIDDLE_MOUSE_BUTTON ? 1 : 0,
      `button ${button} mousedown preventDefault count`,
    );

    const drag = makeEvent(button, 4, 6);
    const skipReorder = handleTabDragThresholdDragStart(drag.event as unknown as React.DragEvent);
    assert.equal(skipReorder, false, `button ${button} must not skip dragstart`);
    assert.equal(isTabDragReorderStarted(), true, `button ${button} must still arm reorder chrome`);
    assert.equal(drag.calls.preventDefault, 0, `button ${button} dragstart must not preventDefault`);
  }
  handleTabDragThresholdReset();
});

test("handleTabDragThresholdReset drops a press so the next drag is not judged from stale coordinates", () => {
  handleTabDragThresholdReset();
  beginPrimaryPress(0, 0);
  handleTabDragThresholdReset();

  const drag = makeEvent(0, 1, 0);
  const skipReorder = handleTabDragThresholdDragStart(drag.event as unknown as React.DragEvent);
  assert.equal(skipReorder, false);
  assert.equal(drag.calls.preventDefault, 0);

  beginPrimaryPress(0, 0);
  const next = makeEvent(0, 1, 0);
  assert.equal(handleTabDragThresholdDragStart(next.event as unknown as React.DragEvent), true);
  assert.equal(next.calls.preventDefault, 0);
  handleTabDragThresholdReset();
});

test("handleTabCloseButtonMouseDown blocks ancestor drag only for the primary button", () => {
  const left = makeEvent(0);
  handleTabCloseButtonMouseDown(left.event);
  assert.equal(left.calls.preventDefault, 1);
  assert.equal(left.calls.stopPropagation, 1);

  for (const button of [MIDDLE_MOUSE_BUTTON, 2]) {
    const other = makeEvent(button);
    handleTabCloseButtonMouseDown(other.event);
    assert.equal(other.calls.preventDefault, 0, `button ${button} must not preventDefault`);
    assert.equal(other.calls.stopPropagation, 0, `button ${button} must not stopPropagation`);
  }
});
