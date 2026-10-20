/**
 * xterm.js arms its `insertText` dedupe guard (`_keyDownSeen`) on every
 * keydown and only clears it on keyup. A pure modifier keydown never emits
 * text itself, but on Windows Sogou Pinyin commits the pending preedit text
 * when Shift toggles Chinese/English mode — and the composed `input` event
 * that carries the commit is delivered right after the Shift keydown. The
 * armed guard then suppresses that event, so the committed text never
 * reaches `onData` and the preedit text vanishes (#3441).
 *
 * Same root cause as upstream xtermjs/xterm.js#6054: a modifier keydown
 * never produces text itself, so it must not arm the "a real keydown was
 * already handled" heuristic. Preserve the pre-keydown guard state for
 * modifier-only keydowns (both `key === "Shift"` and legacy keyCode 16/17/
 * 18 shapes) so composed IME commits still arrive through `_inputEvent`.
 */

import type { Terminal as XTerm } from "@xterm/xterm";
import { isModifierOnlyKey } from "./terminalImeTextInput";

/** Classic keyCodes that stand for a modifier-only keydown. */
const MODIFIER_KEY_CODES = new Set([16, 17, 18, 91, 92, 93, 224]);

/**
 * keyCode 229 is the DOM "composition" key. Windows Sogou in Chinese mode
 * uses it for latin letters and for the Enter that commits them, without
 * ever firing composition events (#3185).
 */
const IME_PROCESS_KEY_CODE = 229;

export function isModifierOnlyKeyDownEvent(event: {
  key: string;
  keyCode?: number;
}): boolean {
  return (
    isModifierOnlyKey(event.key)
    || (event.keyCode !== undefined && MODIFIER_KEY_CODES.has(event.keyCode))
  );
}

type XTermInputCore = {
  _keyDown?: (event: KeyboardEvent) => boolean | undefined;
  _keyDownSeen?: boolean;
};

type CompositionHelperSnapshot = {
  _isComposing?: boolean;
  _isSendingComposition?: boolean;
  _textareaChangeTimer?: unknown;
};

type LateImeInsertCore = XTermInputCore & {
  textarea?: HTMLTextAreaElement | null;
  onWillOpen?: (listener: () => void) => { dispose?: () => void } | void;
  _compositionHelper?: CompositionHelperSnapshot;
  __ncLateImeInsertInstalled?: boolean;
};

type TextareaWithLateImeInsert = HTMLTextAreaElement & {
  __ncLateImeInsert?: boolean;
};

/**
 * An IME commit that arrives as an `input` event. Sogou's latin commit is
 * `inputType: "insertText"` with the committed string in `data`.
 */
function isImeTextInsert(event: {
  inputType?: string;
  data?: string | null;
}): boolean {
  return (
    event.inputType === "insertText"
    && typeof event.data === "string"
    && event.data.length > 0
  );
}

/**
 * insertText events the punctuation deferral already forwarded via
 * `commitImeTextInput`. That handler runs on an ancestor during capture,
 * before this guard, and the same event object reaches both.
 */
const imeDeferralConsumedInputs = new WeakSet<object>();

/** Keep xterm from sending an insertText the IME deferral already committed. */
export function markImeDeferralConsumedInput(event: object): void {
  imeDeferralConsumedInputs.add(event);
}

function isImeDeferralConsumedInput(event: object): boolean {
  return imeDeferralConsumedInputs.has(event);
}

/**
 * True when xterm's `_inputEvent` must be allowed to forward this insert.
 * The 0ms CompositionHelper check already ran and found nothing; the
 * committed text showed up on a later task. Clearing `_keyDownSeen` is the
 * only change: xterm's own handler performs the send.
 *
 * While that check is still scheduled, the textarea already holds the text
 * and the check will send it. Leaving the flag armed stops `_inputEvent`
 * from sending the same string again. The same holds when the punctuation
 * deferral already committed this insert: its handler sent the text, so the
 * flag must stay armed.
 */
function shouldReleaseKeyDownSeenForLateImeInsert(state: {
  inputType?: string;
  data?: string | null;
  inputComposing?: boolean;
  keyDownSeen: boolean;
  lastKeyCode?: number;
  compositionActive: boolean;
  compositionSendPending: boolean;
  textareaCheckPending: boolean;
  deferralConsumed: boolean;
}): boolean {
  if (state.deferralConsumed) return false;
  if (!isImeTextInsert(state)) return false;
  if (state.inputComposing) return false;
  if (!state.keyDownSeen || state.lastKeyCode !== IME_PROCESS_KEY_CODE) return false;
  if (state.compositionActive || state.compositionSendPending) return false;
  if (state.textareaCheckPending) return false;
  return true;
}

/**
 * Wrap xterm's keydown entry so a pure modifier keydown cannot arm the
 * `insertText` dedupe guard. Installed per-terminal instance; the prototype
 * method stays untouched.
 */
export function keepImeCommittedTextThroughModifierKeyDowns(term: XTerm): void {
  const core = (term as XTerm & { _core?: XTermInputCore })._core;
  if (!core || typeof core._keyDown !== "function") return;
  const originalKeyDown = core._keyDown.bind(core);
  core._keyDown = (event: KeyboardEvent) => {
    if (!isModifierOnlyKeyDownEvent(event)) return originalKeyDown(event);
    const seenBefore = core._keyDownSeen;
    try {
      return originalKeyDown(event);
    } finally {
      core._keyDownSeen = seenBefore;
    }
  };
}

/**
 * Windows Sogou (Chinese mode, no inline composition) commits latin text
 * with a late `insertText` after keyCode 229. CompositionHelper snapshots
 * the still-empty textarea and its 0ms check runs before that text exists,
 * so it sends nothing. xterm has already armed `_keyDownSeen`, and
 * `_inputEvent` then drops the insert. The string sits in the hidden
 * textarea until the next Enter wipes it and only `\r` reaches the PTY
 * (#3185).
 *
 * A capture-phase listener registered from `onWillOpen` runs before
 * xterm binds its own `input` handler. It clears `_keyDownSeen` only for
 * the late-insert case above, so xterm forwards the text exactly once.
 * Installed per terminal, before `open()`, next to the modifier guard.
 */
export function keepLateImeTextInsert(term: XTerm): void {
  const core = (term as XTerm & { _core?: LateImeInsertCore })._core;
  if (!core || typeof core._keyDown !== "function" || core.__ncLateImeInsertInstalled) return;
  core.__ncLateImeInsertInstalled = true;

  let lastKeyCode: number | undefined;
  const originalKeyDown = core._keyDown.bind(core);
  core._keyDown = (event: KeyboardEvent) => {
    lastKeyCode = event.keyCode;
    return originalKeyDown(event);
  };

  const onInput = (event: Event) => {
    const input = event as Partial<InputEvent>;
    const helper = core._compositionHelper;
    if (!shouldReleaseKeyDownSeenForLateImeInsert({
      inputType: input.inputType,
      data: input.data,
      inputComposing: input.isComposing === true,
      keyDownSeen: core._keyDownSeen === true,
      lastKeyCode,
      compositionActive: helper?._isComposing === true,
      compositionSendPending: helper?._isSendingComposition === true,
      // No helper means the 0ms check cannot be observed. Treat that as
      // still pending so a late insert is not forwarded twice.
      textareaCheckPending: helper == null || helper._textareaChangeTimer != null,
      deferralConsumed: isImeDeferralConsumedInput(event),
    })) return;
    core._keyDownSeen = false;
  };

  const attach = (textarea: HTMLTextAreaElement | null | undefined) => {
    if (!textarea || (textarea as TextareaWithLateImeInsert).__ncLateImeInsert) return;
    (textarea as TextareaWithLateImeInsert).__ncLateImeInsert = true;
    textarea.addEventListener("input", onInput, true);
  };

  // `open()` creates the textarea and fires `onWillOpen` before `_bindKeys`
  // registers xterm's capture-phase input handler. Attaching here puts our
  // listener ahead of that handler. A terminal that is already open (tests)
  // exposes the textarea directly.
  if (core.textarea) {
    attach(core.textarea);
    return;
  }
  core.onWillOpen?.(() => attach(core.textarea));
}
