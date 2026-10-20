import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import {
  isModifierOnlyKeyDownEvent,
  keepImeCommittedTextThroughModifierKeyDowns,
  keepLateImeTextInsert,
  markImeDeferralConsumedInput,
} from "./imeModifierKeyDownSeenGuard";
import { keepLiveImeTranscriptionSingle } from "./imeCompositionRewrite";

const runtimeSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "createXTermRuntime.ts"),
  "utf8",
);

test("isModifierOnlyKeyDownEvent accepts both DOM key and classic keyCode shapes", () => {
  assert.equal(isModifierOnlyKeyDownEvent({ key: "Shift", keyCode: 16 }), true);
  assert.equal(isModifierOnlyKeyDownEvent({ key: "Shift" }), true);
  assert.equal(isModifierOnlyKeyDownEvent({ key: "Control", keyCode: 17 }), true);
  assert.equal(isModifierOnlyKeyDownEvent({ key: "Alt", keyCode: 18 }), true);
  assert.equal(isModifierOnlyKeyDownEvent({ key: "Meta", keyCode: 91 }), true);
  assert.equal(isModifierOnlyKeyDownEvent({ key: "CapsLock" }), true);
});

test("isModifierOnlyKeyDownEvent rejects real keys and IME process events", () => {
  assert.equal(isModifierOnlyKeyDownEvent({ key: "a", keyCode: 65 }), false);
  assert.equal(isModifierOnlyKeyDownEvent({ key: "Process", keyCode: 229 }), false);
  assert.equal(isModifierOnlyKeyDownEvent({ key: "Enter", keyCode: 13 }), false);
  assert.equal(isModifierOnlyKeyDownEvent({ key: "Dead", keyCode: 221 }), false);
});

type FakeCore = {
  _keyDown: (event: Pick<KeyboardEvent, "key" | "keyCode">) => boolean;
  _keyDownSeen: boolean;
  _keyUp: () => void;
};

function createFakeCore(initialSeen = false): {
  core: FakeCore;
  term: { _core: FakeCore };
} {
  const core: FakeCore = {
    _keyDownSeen: initialSeen,
    _keyDown(_event) {
      // Mirrors xterm: every keydown arms the insertText dedupe guard.
      this._keyDownSeen = true;
      return true;
    },
    _keyUp() {
      this._keyDownSeen = false;
    },
  };
  return { core, term: { _core: core } };
}

test("keepImeCommittedTextThroughModifierKeyDowns preserves seen state across Shift keydown", () => {
  // Sogou Shift commit: a previous real keydown armed the guard, and the
  // Shift keydown must not re-arm (or clear) it before the composed input.
  const { core, term } = createFakeCore(false);
  keepImeCommittedTextThroughModifierKeyDowns(term as never);
  core._keyDown({ key: "Shift", keyCode: 16 } as KeyboardEvent);
  assert.equal(core._keyDownSeen, false);
});

test("keepImeCommittedTextThroughModifierKeyDowns keeps guard armed for real keydowns", () => {
  const { core, term } = createFakeCore(false);
  keepImeCommittedTextThroughModifierKeyDowns(term as never);
  core._keyDown({ key: "a", keyCode: 65 } as KeyboardEvent);
  assert.equal(core._keyDownSeen, true);
});

test("keepImeCommittedTextThroughModifierKeyDowns preserves an already-armed guard", () => {
  const { core, term } = createFakeCore(true);
  keepImeCommittedTextThroughModifierKeyDowns(term as never);
  core._keyDown({ key: "Shift" } as KeyboardEvent);
  assert.equal(core._keyDownSeen, true);
});

test("keepImeCommittedTextThroughModifierKeyDowns leaves non-modifier behavior intact", () => {
  const { core, term } = createFakeCore(false);
  keepImeCommittedTextThroughModifierKeyDowns(term as never);
  core._keyDown({ key: "Process", keyCode: 229 } as KeyboardEvent);
  assert.equal(core._keyDownSeen, true);
  core._keyDown({ key: "Control", keyCode: 17 } as KeyboardEvent);
  assert.equal(core._keyDownSeen, true, "Control still restored to true (was true)");
});

test("guard tolerates a terminal without an introspectable core", () => {
  assert.doesNotThrow(() => {
    keepImeCommittedTextThroughModifierKeyDowns({} as never);
  });
});

test("runtime installs the guard when the terminal is created", () => {
  assert.match(
    runtimeSource,
    /keepImeCommittedTextThroughModifierKeyDowns\(term\)/,
  );
  assert.match(
    runtimeSource,
    /commitImeTextInput\(event\.data\);\s*\/\/ This insert was already sent\. Leave xterm's dedupe flag armed\.\s*markImeDeferralConsumedInput\(event\);/,
  );
  const modifierAt = runtimeSource.indexOf("keepImeCommittedTextThroughModifierKeyDowns(term)");
  const lateAt = runtimeSource.indexOf("keepLateImeTextInsert(term)");
  const openAt = runtimeSource.indexOf("term.open(ctx.container)");
  assert.ok(lateAt > modifierAt, "late IME insert guard is installed with the modifier guard");
  assert.ok(lateAt < openAt, "late IME insert guard is installed before open() binds xterm input");
});

type XTermModule = {
  Terminal: new (options?: {
    allowProposedApi?: boolean;
    cols?: number;
    rows?: number;
    cursorBlink?: boolean;
  }) => {
    open(parent: HTMLElement): void;
    onData(listener: (data: string) => void): { dispose(): void };
    dispose(): void;
    textarea: HTMLTextAreaElement | undefined;
    _core: { _keyDownSeen?: boolean };
  };
};

let xtermModule: XTermModule | undefined;
let domWindow: JSDOM["window"] | undefined;

function installXtermDom(): JSDOM["window"] {
  if (domWindow) return domWindow;
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const win = dom.window;
  win.matchMedia = () => ({
    matches: false,
    media: "",
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  });
  const context = {
    font: "10px monospace",
    measureText: () => ({ width: 8 }),
    fillRect() {},
    clearRect() {},
    fillText() {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData() {},
    scale() {},
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
    rect() {},
    clip() {},
  };
  win.HTMLCanvasElement.prototype.getContext = () => context as unknown as CanvasRenderingContext2D;
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    HTMLElement: win.HTMLElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    KeyboardEvent: win.KeyboardEvent,
    InputEvent: win.InputEvent,
    CompositionEvent: win.CompositionEvent,
    Node: win.Node,
    Element: win.Element,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16),
  });
  domWindow = win;
  return win;
}

async function loadXterm(): Promise<XTermModule> {
  if (xtermModule) return xtermModule;
  installXtermDom();
  const imported = await import("@xterm/xterm");
  const terminal = (imported as { default?: XTermModule }).default?.Terminal
    ?? (imported as unknown as XTermModule).Terminal;
  xtermModule = { Terminal: terminal };
  return xtermModule;
}

function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function withKeyCode(event: Event, keyCode: number): Event {
  Object.defineProperty(event, "keyCode", { get: () => keyCode });
  Object.defineProperty(event, "which", { get: () => keyCode });
  return event;
}

/**
 * Production wiring: both guards before open(), transcription rewrite after.
 * xterm's input listener is registered during open(), after onWillOpen.
 */
async function openGuardedTerminal(): Promise<{
  term: InstanceType<XTermModule["Terminal"]>;
  textarea: HTMLTextAreaElement;
  sent: string[];
  win: JSDOM["window"];
}> {
  const win = installXtermDom();
  const { Terminal } = await loadXterm();
  const parent = win.document.createElement("div");
  win.document.body.appendChild(parent);
  const term = new Terminal({
    allowProposedApi: true,
    cols: 80,
    rows: 24,
    cursorBlink: false,
  });
  assert.equal(term.textarea, undefined, "textarea exists only after open()");
  keepImeCommittedTextThroughModifierKeyDowns(term as never);
  keepLateImeTextInsert(term as never);
  term.open(parent);
  keepLiveImeTranscriptionSingle(term);
  const textarea = term.textarea;
  assert.ok(textarea, "open() creates the helper textarea");
  const sent: string[] = [];
  term.onData((data) => sent.push(data));
  return { term, textarea: textarea as HTMLTextAreaElement, sent, win };
}

function closeTerminal(term: { dispose(): void }): void {
  term.dispose();
}

function dispatchKey(
  win: JSDOM["window"],
  textarea: HTMLTextAreaElement,
  type: "keydown" | "keyup",
  key: string,
  keyCode: number,
): void {
  const event = withKeyCode(
    new win.KeyboardEvent(type, { key, bubbles: true, cancelable: true }),
    keyCode,
  );
  textarea.dispatchEvent(event);
}

function dispatchInsert(
  win: JSDOM["window"],
  textarea: HTMLTextAreaElement,
  data: string,
  init: { isComposing?: boolean } = {},
): InputEvent {
  textarea.value = data;
  const event = new win.InputEvent("input", {
    data,
    inputType: "insertText",
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  if (init.isComposing) {
    Object.defineProperty(event, "isComposing", { get: () => true });
  }
  assert.equal(event.composed, true, "IME insertText is a composed event, so _keyDownSeen can drop it");
  assert.equal(event.inputType, "insertText");
  assert.equal(event.data, data);
  textarea.dispatchEvent(event);
  return event;
}

test("late insert guard does not undo the modifier keydown guard", () => {
  const { core, term } = createFakeCore(false);
  keepImeCommittedTextThroughModifierKeyDowns(term as never);
  keepLateImeTextInsert(term as never);
  core._keyDown({ key: "Shift", keyCode: 16 } as KeyboardEvent);
  assert.equal(core._keyDownSeen, false);
  core._keyDown({ key: "a", keyCode: 65 } as KeyboardEvent);
  assert.equal(core._keyDownSeen, true);
});

test("late keyCode 229 insertText is forwarded exactly once", async () => {
  const { term, textarea, sent, win } = await openGuardedTerminal();
  try {
    for (let index = 0; index < "qzmark".length; index += 1) {
      dispatchKey(win, textarea, "keydown", "Process", 229);
      await flushMacrotask();
    }
    dispatchKey(win, textarea, "keydown", "Enter", 229);
    await flushMacrotask();
    assert.deepEqual(sent, [], "the 0ms check runs before Sogou's text and sends nothing");

    dispatchInsert(win, textarea, "qzmark");
    assert.deepEqual(sent, ["qzmark"]);

    dispatchKey(win, textarea, "keyup", "Enter", 229);
    dispatchKey(win, textarea, "keydown", "Enter", 13);
    assert.deepEqual(sent, ["qzmark", "\r"]);
  } finally {
    closeTerminal(term);
  }
});

test("insertText that arrives before the 0ms check is not sent twice", async () => {
  const { term, textarea, sent, win } = await openGuardedTerminal();
  try {
    dispatchKey(win, textarea, "keydown", "Enter", 229);
    dispatchInsert(win, textarea, "qzmark");
    assert.deepEqual(sent, [], "xterm's handler still ignores the insert while the check is pending");
    await flushMacrotask();
    assert.deepEqual(sent, ["qzmark"]);
  } finally {
    closeTerminal(term);
  }
});

test("normal composition still commits once", async () => {
  const { term, textarea, sent, win } = await openGuardedTerminal();
  try {
    dispatchKey(win, textarea, "keydown", "Process", 229);
    textarea.dispatchEvent(new win.CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value = "\u4f60\u597d";
    textarea.dispatchEvent(new win.CompositionEvent("compositionupdate", {
      data: "\u4f60\u597d",
      bubbles: true,
    }));
    dispatchInsert(win, textarea, "\u4f60\u597d", { isComposing: true });
    textarea.dispatchEvent(new win.CompositionEvent("compositionend", {
      data: "\u4f60\u597d",
      bubbles: true,
    }));
    await flushMacrotask();
    await flushMacrotask();
    assert.equal(sent.join(""), "\u4f60\u597d");
  } finally {
    closeTerminal(term);
  }
});

test("insertText already committed by the IME deferral is not sent again", async () => {
  // A deferred punctuation key whose keyup was swallowed stays armed across
  // later keyCode 229 keydowns. markKittyTextInput then commits the eventual
  // insertText before this guard runs; xterm must not emit that string too.
  const { term, textarea, sent, win } = await openGuardedTerminal();
  try {
    const ancestor = textarea.parentElement;
    assert.ok(ancestor);
    ancestor.addEventListener("input", (event) => {
      const input = event as InputEvent;
      if (input.inputType !== "insertText" || !input.data) return;
      markImeDeferralConsumedInput(event);
      sent.push(input.data);
    }, true);

    dispatchKey(win, textarea, "keydown", "Enter", 229);
    await flushMacrotask();
    assert.deepEqual(sent, [], "the 0ms check still finds no text");

    dispatchInsert(win, textarea, "qzmark");
    assert.deepEqual(sent, ["qzmark"]);
    assert.equal(term._core._keyDownSeen, true);
  } finally {
    closeTerminal(term);
  }
});

test("a non-229 keydown still dedupes its insertText", async () => {
  const { term, textarea, sent, win } = await openGuardedTerminal();
  try {
    dispatchKey(win, textarea, "keydown", "a", 65);
    dispatchInsert(win, textarea, "a");
    assert.equal(sent.join(""), "a");
    assert.equal(term._core._keyDownSeen, true);
  } finally {
    closeTerminal(term);
  }
});
