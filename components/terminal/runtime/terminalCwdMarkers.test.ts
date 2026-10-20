import assert from "node:assert/strict";
import test from "node:test";

import { createTerminalCwdMarkers } from "./terminalCwdMarkers.ts";

type FakeMarker = {
  line: number;
  isDisposed: boolean;
  dispose: () => void;
};

function harness() {
  let cursorLine = 0;
  let cursorX = 0;
  let cols = 80;
  let type: "normal" | "alternate" = "normal";
  const created: FakeMarker[] = [];
  const term = {
    get cols() {
      return cols;
    },
    buffer: {
      active: {
        get type() {
          return type;
        },
        get cursorX() {
          return cursorX;
        },
      },
    },
    registerMarker(offset: number) {
      const marker: FakeMarker = {
        line: cursorLine + offset,
        isDisposed: false,
        dispose() {
          this.isDisposed = true;
        },
      };
      created.push(marker);
      return marker;
    },
  };
  const markers = createTerminalCwdMarkers(term as never);
  return {
    markers,
    created,
    setCursor(line: number, x = 0) {
      cursorLine = line;
      cursorX = x;
    },
    setCols(next: number) {
      cols = next;
    },
    setType(next: "normal" | "alternate") {
      type = next;
    },
  };
}

test("prompt-only intervals are trusted only when both ends report the same cwd", () => {
  const same = harness();
  same.setCursor(0);
  same.markers.note({ cwd: "/a", host: "box" });
  same.setCursor(3);
  same.markers.note({ cwd: "/a", host: "box" });
  assert.deepEqual(same.markers.resolveCell(1, 0), { cwd: "/a", host: "box" });

  const changed = harness();
  changed.setCursor(0);
  changed.markers.note({ cwd: "/a", host: "box" });
  changed.setCursor(3);
  changed.markers.note({ cwd: "/a/x", host: "box" });
  assert.equal(changed.markers.resolveCell(1, 0), null);

  const thenCd = harness();
  thenCd.setCursor(0);
  thenCd.markers.note({ cwd: "/a", host: "box" });
  thenCd.setCursor(4);
  thenCd.markers.note({ cwd: "/a/x", host: "box" });
  assert.equal(thenCd.markers.resolveCell(2, 0), null);
});

test("a chpwd emitter trusts the interval after the directory change", () => {
  const h = harness();
  h.setCursor(0);
  h.markers.note({ cwd: "/a", host: "box" });
  h.setCursor(2);
  h.markers.note({ cwd: "/a/x", host: "box" });
  h.setCursor(5);
  h.markers.note({ cwd: "/a/x", host: "box" });
  assert.equal(h.markers.resolveCell(1, 0), null);
  assert.deepEqual(h.markers.resolveCell(3, 0), { cwd: "/a/x", host: "box" });
});

test("the open interval after the latest marker is not trusted", () => {
  const h = harness();
  h.setCursor(0);
  h.markers.note({ cwd: "/a", host: "box" });
  h.setCursor(2);
  h.markers.note({ cwd: "/a", host: "box" });
  assert.deepEqual(h.markers.resolveCell(1, 0), { cwd: "/a", host: "box" });
  assert.equal(h.markers.resolveCell(4, 0), null);
});

test("a host mismatch between interval ends is not trusted and latestHost follows the last marker", () => {
  const h = harness();
  h.setCursor(0);
  h.markers.note({ cwd: "/a", host: "outer" });
  h.setCursor(2);
  h.markers.note({ cwd: "/a", host: "inner" });
  assert.equal(h.markers.resolveCell(1, 0), null);
  assert.equal(h.markers.latestHost(), "inner");
});

test("a disposed start or end marker drops the interval", () => {
  const start = harness();
  start.setCursor(0);
  start.markers.note({ cwd: "/a", host: "box" });
  start.setCursor(2);
  start.markers.note({ cwd: "/a", host: "box" });
  start.created[0]?.dispose();
  assert.equal(start.markers.resolveCell(1, 0), null);

  const end = harness();
  end.setCursor(0);
  end.markers.note({ cwd: "/a", host: "box" });
  end.setCursor(2);
  end.markers.note({ cwd: "/a", host: "box" });
  end.created[1]?.dispose();
  assert.equal(end.markers.resolveCell(1, 0), null);
});

test("a new marker above existing ones drops the later markers", () => {
  const h = harness();
  h.setCursor(0);
  h.markers.note({ cwd: "/a", host: "box" });
  h.setCursor(5);
  h.markers.note({ cwd: "/a", host: "box" });
  h.setCursor(10);
  h.markers.note({ cwd: "/a", host: "box" });
  h.setCursor(3);
  h.markers.note({ cwd: "/a", host: "box" });
  assert.equal(h.created[1]?.isDisposed, true);
  assert.equal(h.created[2]?.isDisposed, true);
  assert.equal(h.created[0]?.isDisposed, false);
  assert.deepEqual(h.markers.resolveCell(1, 0), { cwd: "/a", host: "box" });
  assert.equal(h.markers.resolveCell(6, 0), null);
});

test("cells left of a marker belong to the previous interval and a cols change makes that row ambiguous", () => {
  const split = harness();
  split.setCursor(0, 0);
  split.markers.note({ cwd: "/old", host: "box" });
  split.setCursor(5, 10);
  split.markers.note({ cwd: "/new", host: "box" });
  split.setCursor(9, 0);
  split.markers.note({ cwd: "/new", host: "box" });
  assert.equal(split.markers.resolveCell(5, 9), null);
  assert.deepEqual(split.markers.resolveCell(5, 10), { cwd: "/new", host: "box" });
  assert.deepEqual(split.markers.resolveCell(7, 0), { cwd: "/new", host: "box" });

  const resized = harness();
  resized.setCursor(0, 0);
  resized.markers.note({ cwd: "/a", host: "box" });
  resized.setCursor(5, 4);
  resized.markers.note({ cwd: "/a", host: "box" });
  resized.setCursor(9, 0);
  resized.markers.note({ cwd: "/a", host: "box" });
  resized.setCols(100);
  assert.equal(resized.markers.resolveCell(5, 0), null);
  assert.equal(resized.markers.resolveCell(5, 4), null);
  assert.equal(resized.markers.resolveCell(0, 1), null);
  assert.deepEqual(resized.markers.resolveCell(3, 0), { cwd: "/a", host: "box" });
});

test("the alternate buffer does not record cwd markers", () => {
  const h = harness();
  h.setType("alternate");
  h.setCursor(0);
  h.markers.note({ cwd: "/a", host: "box" });
  assert.equal(h.created.length, 0);
  assert.equal(h.markers.resolveCell(0, 0), null);
  assert.equal(h.markers.latestHost(), null);
});
