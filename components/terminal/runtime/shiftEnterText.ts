import type { TerminalSettings } from "../../../domain/models";

export const DEFAULT_SHIFT_ENTER_TEXT = "\\e\\r";

/** Kitty CSI-u encoding for Shift+Enter (keycode 13, modifier shift → 2). */
export const SHIFT_ENTER_CSI_U_SEQUENCE = "\u001b[13;2u";

// Structural subset shared by DOM KeyboardEvent and KittyKeyboardEvent, whose
// type and modifier fields are optional.
type ShiftEnterEvent = {
  type?: string;
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
};

export function decodeTerminalTextEscapes(text: string): string {
  let decoded = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "\\" || index >= text.length - 1) {
      decoded += char;
      continue;
    }

    const next = text[index + 1];
    switch (next) {
      case "n":
        decoded += "\n";
        index += 1;
        break;
      case "r":
        decoded += "\r";
        index += 1;
        break;
      case "t":
        decoded += "\t";
        index += 1;
        break;
      case "e":
        decoded += "\u001b";
        index += 1;
        break;
      case "\\":
        decoded += "\\";
        index += 1;
        break;
      default:
        decoded += char;
        break;
    }
  }

  return decoded;
}

export function shouldSendShiftEnterText(
  event: ShiftEnterEvent,
  settings?: Pick<TerminalSettings, "shiftEnterNewlineEnabled">,
): boolean {
  return (
    settings?.shiftEnterNewlineEnabled !== false &&
    event.type === "keydown" &&
    event.key === "Enter" &&
    event.shiftKey === true &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing
  );
}

export function resolveShiftEnterText(
  settings?: Pick<TerminalSettings, "shiftEnterNewlineText">,
): string {
  const configured = settings?.shiftEnterNewlineText;
  return decodeTerminalTextEscapes(
    typeof configured === "string" ? configured : DEFAULT_SHIFT_ENTER_TEXT,
  );
}

export function isBareShiftEnterLineEnding(text: string): boolean {
  return text === "\n" || text === "\r" || text === "\r\n";
}

/**
 * True when Kitty encoding already keeps Shift+Enter distinct from plain Enter.
 * Non-preserving flag sets (e.g. alternate-key or associated-text alone) still
 * encode Shift+Enter as a bare CR/LF, so the alternate-screen remap must run.
 */
export function doesKittyEncodingPreserveShiftEnter(
  encoded: string | null | undefined,
): boolean {
  return typeof encoded === "string"
    && encoded.length > 0
    && !isBareShiftEnterLineEnding(encoded);
}

/**
 * xterm 6.1 flag bits that encode Shift+Enter as CSI 13;2u.
 * Disambiguate (1), report event types (2), and report all keys (8).
 * Alternate-key (4) or associated-text (16) alone still emit a bare CR.
 */
const NATIVE_KITTY_SHIFT_ENTER_CSI_U_FLAGS = 0b0001 | 0b0010 | 0b1000;

export function nativeKittyKeyboardPreservesShiftEnter(flags: number): boolean {
  return (flags & NATIVE_KITTY_SHIFT_ENTER_CSI_U_FLAGS) !== 0;
}

export function readNativeKittyKeyboardFlags(term: {
  _core?: { coreService?: { kittyKeyboard?: { flags?: unknown } } };
}): number {
  const flags = term._core?.coreService?.kittyKeyboard?.flags;
  return typeof flags === "number" && Number.isFinite(flags) ? flags : 0;
}

export function isShiftEnterLineContinuationText(text: string): boolean {
  return /\\(?:\r\n|\r|\n)$/.test(text);
}

export type ShiftEnterSubmittedInput = {
  text: string;
  lineEnding: "\r\n" | "\r" | "\n";
};

/** ESC immediately before a terminating CR is the legacy Alt+Enter line break. */
function isAltEnterLineBreak(text: string): boolean {
  return text.endsWith("\u001b\r") || text.endsWith("\u001b\r\n");
}

export function getShiftEnterSubmittedInput(
  text: string,
): ShiftEnterSubmittedInput | null {
  if (isShiftEnterLineContinuationText(text) || isAltEnterLineBreak(text)) return null;
  const match = text.match(/^([^\r\n]*)(\r\n|\r|\n)$/);
  if (!match) return null;
  return {
    text: match[1],
    lineEnding: match[2] as ShiftEnterSubmittedInput["lineEnding"],
  };
}

/**
 * Text to send instead of the native Win32 INPUT_RECORD for Shift+Enter, or
 * null when the native record should be kept. Only the explicit
 * shiftEnterForceText opt-out overrides the ConPTY Win32 hand-off, and an
 * empty configured text never claims the key.
 */
export function resolveWin32ForcedShiftEnterText(
  event: ShiftEnterEvent,
  settings?: Pick<
    TerminalSettings,
    "shiftEnterNewlineEnabled" | "shiftEnterNewlineText" | "shiftEnterForceText"
  >,
): string | null {
  if (settings?.shiftEnterForceText !== true) return null;
  if (!shouldSendShiftEnterText(event, settings)) return null;
  return resolveShiftEnterText(settings) || null;
}

/**
 * Whether a local Shift+Enter keydown should be claimed for the configured
 * text. Under ConPTY Win32 input mode the native record wins unless the user
 * opted out with shiftEnterForceText; elsewhere the text is used only when the
 * negotiated Kitty encoding would collapse the chord to a bare CR/LF, so the
 * Win32 opt-out can never override a Kitty encoding that preserves it.
 * xterm's own CSI-u mode is the same kind of preserving encoding: step aside
 * so the app receives CSI 13;2u.
 */
export function shouldClaimShiftEnterForText(
  event: ShiftEnterEvent,
  settings: Pick<
    TerminalSettings,
    "shiftEnterNewlineEnabled" | "shiftEnterForceText"
  > | undefined,
  mode: {
    win32InputMode: boolean;
    kittySequenceForKeyDown: string | null;
    nativeKittyPreservesShiftEnter?: boolean;
  },
): boolean {
  if (!shouldSendShiftEnterText(event, settings)) return false;
  if (mode.win32InputMode) return settings?.shiftEnterForceText === true;
  if (doesKittyEncodingPreserveShiftEnter(mode.kittySequenceForKeyDown)) return false;
  if (mode.nativeKittyPreservesShiftEnter) return false;
  return true;
}
