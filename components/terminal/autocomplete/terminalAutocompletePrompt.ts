import { isSensitiveTerminalChallenge } from "../../../domain/terminalPromptSecurity";
import {
  isNonPromptLine,
  isProgramInputPromptText,
  reconcilePromptWithExternalCommand,
  type PromptDetectionResult,
} from "./promptDetector";
import { parseCommandLine, type CompletionSuggestion } from "./completionEngine";
import { computeLivePreviewWrite, isWindowsShellLineInput } from "./livePreviewSequence";

const THEMED_PROMPT_MARKERS = /[❯❮→➜➤⟩»›]/;

function hasStandardShellPromptTerminator(promptText: string): boolean {
  return /[$#%>]$/.test(promptText.trimEnd());
}

function isSingleThemedPromptTerminator(promptText: string): boolean {
  const trimmed = promptText.trim();
  if (trimmed.length !== 1) return false;
  const code = trimmed.charCodeAt(0);
  return THEMED_PROMPT_MARKERS.test(trimmed) || (code >= 0xE000 && code <= 0xF8FF);
}

function isThemedPromptPathToken(token: string): boolean {
  return (
    token === "~" ||
    token.startsWith("~/") ||
    token.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(token) ||
    token.includes("\\")
  );
}

function hasThemedPromptDecorationInInput(prompt: PromptDetectionResult): boolean {
  const hasThemedPromptMarker =
    THEMED_PROMPT_MARKERS.test(prompt.promptText) ||
    Array.from(prompt.promptText).some((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0xE000 && code <= 0xF8FF;
    });
  if (hasThemedPromptMarker && hasStandardShellPromptTerminator(prompt.promptText)) {
    return false;
  }
  if (hasThemedPromptMarker && isSingleThemedPromptTerminator(prompt.promptText)) {
    const firstToken = prompt.userInput.trimStart().match(/^\S+/)?.[0] ?? "";
    return (
      (prompt.userInput.startsWith(" ") || isThemedPromptPathToken(firstToken)) &&
      /\S+\s+\S/.test(prompt.userInput)
    );
  }
  return hasThemedPromptMarker && /\S+\s+\S/.test(prompt.userInput);
}

/**
 * Command-line text used for autocomplete matching (popup / ghost).
 *
 * Enter recording keeps a stricter echo-alignment policy so short lagging
 * prefixes are not committed as history. Autocomplete can safely prefer the
 * reliable keystroke buffer when it is ahead of the remote shell echo —
 * otherwise high-latency SSH drops local history/fig matches until the user
 * pauses and the echo catches up (#2830).
 */
export function resolveAutocompleteQueryInput(
  prompt: PromptDetectionResult,
  typedBuffer: string,
  typedBufferReliable: boolean,
): string | null {
  if (!prompt.isAtPrompt) return null;

  // Prefer the keystroke buffer when it is reliably aligned with the remote
  // echo as a shared prefix in either direction:
  // - buffer ahead of echo (typing faster than SSH echo)
  // - echo ahead of buffer (partial/full backspace while echo still lags)
  // Without the second case, a lagging echo of deleted characters would keep
  // driving completions/accept (e.g. typed `gi` + echo `git` → accept
  // ` status` → remote `gi status`). An unreliable empty buffer is different:
  // history recall / cursor moves clear the buffer without meaning the line
  // is empty, so fall through to prompt.userInput there.
  if (
    typedBufferReliable &&
    (typedBuffer.startsWith(prompt.userInput) ||
      prompt.userInput.startsWith(typedBuffer))
  ) {
    return typedBuffer;
  }

  return prompt.userInput;
}

/**
 * Whether an in-flight completion result still belongs to the active query.
 *
 * Live preview rewrites the typed buffer to the highlighted candidate, so a
 * naive `currentInput === queryInput` check would drop late path listings
 * while a preview row remains selected.
 */
export function isSameAutocompleteQuery(options: {
  queryInput: string;
  currentInput: string | null;
  previewActive: boolean;
  previewBaseline: string;
}): boolean {
  if (options.currentInput === null) return false;
  if (options.currentInput === options.queryInput) return true;
  return options.previewActive && options.previewBaseline === options.queryInput;
}

const TRUSTED_ORDINARY_INPUT_LABELS = new Set([
  "email",
  "e-mail",
  "email address",
  "e-mail address",
  "username",
  "user name",
  "user",
  "userid",
  "user id",
  "login",
  "login name",
  "name",
  "full name",
  "account",
  "account name",
  "\u90ae\u7bb1",
  "\u7535\u5b50\u90ae\u7bb1",
  "\u7535\u5b50\u90ae\u4ef6",
  "\u7528\u6237\u540d",
  "\u7528\u6237",
  "\u59d3\u540d",
  "\u8d26\u53f7",
  "\u5e10\u6237",
  "\u8d26\u6237",
  "\u767b\u5f55\u540d",
]);

const UNTRUSTED_INPUT_LABEL = /(?:\b(?:secret|passphrase|password|passcode|token|key|pin|otp)\b|\u5bc6\u7801|\u53e3\u4ee4|\u4ee4\u724c|\u5bc6\u94a5|\u9a8c\u8bc1\u7801)/iu;

function trustedOrdinaryInputLabel(promptText: string): string | null {
  const trimmedEnd = promptText.trimEnd();
  const marker = trimmedEnd.at(-1);
  if (marker !== ":" && marker !== "\uFF1A") return null;
  return trimmedEnd
    .slice(0, -1)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/^(?:please\s+)?(?:enter|input|type)\s+(?:your\s+)?/u, "")
    .replace(/^your\s+/u, "")
    .replace(/^(?:\u8bf7\u8f93\u5165|\u8bf7|\u8f93\u5165)/u, "")
    .trim();
}

/**
 * Positively identified ordinary identity prompts (`Email:`, `Username:`).
 * Unknown labels stay fail-closed so they cannot bypass the sensitive latch.
 */
function isTrustedOrdinaryInputPromptText(promptText: string): boolean {
  if (UNTRUSTED_INPUT_LABEL.test(promptText)) return false;
  const label = trustedOrdinaryInputLabel(promptText);
  if (!label || UNTRUSTED_INPUT_LABEL.test(label)) return false;
  return TRUSTED_ORDINARY_INPUT_LABELS.has(label);
}

/**
 * Why `sensitiveInputActive` is latched.
 *
 * `heuristic` is the untrusted-prompt detector (`Email:`, unknown `Label:`).
 * `explicit` is authoritative metadata such as `pluginPipelineSensitiveInput`.
 * Omitted means heuristic, so existing callers keep the trusted-label bypass.
 */
export type SensitiveAutocompleteLatchSource = "heuristic" | "explicit";

export type SensitiveInputActiveRef = {
  current: boolean;
  source?: SensitiveAutocompleteLatchSource;
};

/**
 * Whether fetchSuggestions must refuse to query/render for an already-known
 * sensitive line (host latch or auth-challenge prompt text).
 *
 * The heuristic latch is set for every untrusted input boundary, including
 * safe program prompts such as `Email:`. Only a small allowlist of plain
 * identity labels may bypass that latch so snippet candidates can render.
 * An explicit latch (plugin pipeline or other authoritative sensitive
 * metadata) stays closed for those labels too. Unknown labels, and anything
 * password/token/key/PIN/OTP-like, stay closed.
 *
 * This is *not* a substitute for the empty-echo / `allowExternalProviders:
 * false` wait in useTerminalAutocomplete: `read -s -p '$ '` still looks like
 * a normal shell PS1 until echo validates, so that path stays fail-closed
 * separately (#2814).
 */
export function shouldBlockAutocompleteForSensitivePrompt(options: {
  sensitiveInputActive: boolean;
  promptText: string;
  sensitiveSource?: SensitiveAutocompleteLatchSource;
}): boolean {
  const explicitLatch = options.sensitiveInputActive && options.sensitiveSource === "explicit";
  if (
    options.sensitiveInputActive
    && !explicitLatch
    && isTrustedOrdinaryInputPromptText(options.promptText)
  ) {
    return false;
  }
  if (options.sensitiveInputActive) return true;
  return isSensitiveTerminalChallenge(options.promptText);
}

/**
 * Keystrokes that rewrite the remote command line to `candidate`.
 *
 * Must use the same echo-lag-aware baseline as suggestion matching: the remote
 * shell already has the typed buffer, even when local echo still shows a short
 * prefix. Using lagging `prompt.userInput` here would append a duplicate tail
 * (e.g. typed `systemctl` + echo `s` + accept → send `ystemctl …`).
 */
export function computeAutocompleteAcceptWrite(options: {
  prompt: PromptDetectionResult;
  typedBuffer: string;
  typedBufferReliable: boolean;
  candidate: string;
  os: string;
  execute?: boolean;
  allowLineReplacement?: boolean;
}): string | null {
  const currentLine = resolveAutocompleteQueryInput(
    options.prompt,
    options.typedBuffer,
    options.typedBufferReliable,
  );
  if (currentLine === null) return null;

  const allowLineReplacement = options.allowLineReplacement !== false;
  if (
    !options.candidate.startsWith(currentLine) &&
    !allowLineReplacement
  ) {
    return null;
  }

  const body = computeLivePreviewWrite({
    currentLine,
    candidate: options.candidate,
    os: options.os,
    promptText: options.prompt.promptText,
  });
  if (!options.execute) return body;
  return body ? `${body}\r` : "\r";
}

export function getCommandToRecordOnEnter(
  livePrompt: PromptDetectionResult,
  alignedTyped: string | null,
  typedBuffer: string,
  typedBufferReliable: boolean,
): string | null {
  if (!livePrompt.isAtPrompt) return null;
  if (isProgramInputPromptText(livePrompt.promptText)) return null;
  const alignedCommand = alignedTyped?.trim();
  if (alignedCommand) return alignedCommand;

  const reliableTypedCommand = typedBufferReliable ? typedBuffer.trim() : "";
  if (reliableTypedCommand) {
    const reconciledPrompt = reconcilePromptWithExternalCommand(
      livePrompt,
      reliableTypedCommand,
    );
    if (reconciledPrompt) return reliableTypedCommand;
  }

  const liveCommand = livePrompt.userInput.trim();
  if (!liveCommand && reliableTypedCommand) {
    return isNonPromptLine(`${livePrompt.promptText}${reliableTypedCommand}`)
      ? null
      : reliableTypedCommand;
  }
  if (!liveCommand) return null;
  if (!typedBufferReliable && hasThemedPromptDecorationInInput(livePrompt)) return null;

  const liveInputMayIncludePromptDecoration =
    typedBufferReliable &&
    typedBuffer.trim().length > 0 &&
    liveCommand !== typedBuffer.trim() &&
    liveCommand.endsWith(typedBuffer.trim());
  if (liveInputMayIncludePromptDecoration) return null;

  const liveInputMayBeLagging =
    typedBufferReliable &&
    typedBuffer.trim().length > 0 &&
    typedBuffer.length > livePrompt.userInput.length &&
    typedBuffer.startsWith(livePrompt.userInput);
  if (liveInputMayBeLagging) return null;

  if (typedBufferReliable && hasThemedPromptDecorationInInput(livePrompt)) return null;

  return liveCommand;
}

/**
 * Keystrokes that remove the text a snippet acceptance replaces.
 * Line-start keeps the shell kill-line (Ctrl+U, or backspaces on Windows).
 * Mid-line and program read-prompts delete only the word being typed.
 * POSIX word delete sends DEL, the tty erase character. Ctrl-H is literal
 * input to canonical `read` when erase is ^?, while readline still deletes
 * on DEL. Windows line editing keeps backspace.
 * Script snippets run automation and do not replace the line, so they keep
 * the full-line clear.
 */
export function computeSnippetAcceptClearSequence(options: {
  line: string | null;
  os: string;
  promptText: string;
  snippetKind?: "snippet" | "script";
}): string {
  const line = options.line ?? "";
  if (line.length === 0) return "";

  const { currentWord, wordIndex } = parseCommandLine(line);
  const replaceWord = options.snippetKind !== "script"
    && currentWord.length > 0
    && line.endsWith(currentWord)
    && (wordIndex > 0 || isProgramInputPromptText(options.promptText));
  if (replaceWord) {
    const eraseChar = isWindowsShellLineInput(options.os, options.promptText) ? "\b" : "\x7f";
    return eraseChar.repeat(Array.from(currentWord).length);
  }

  return isWindowsShellLineInput(options.os, options.promptText)
    ? "\b".repeat(line.length)
    : "\x15";
}

/** Program read-prompts offer snippets only; shell lines keep every source. */
export function limitSuggestionsForPrompt(
  promptText: string,
  suggestions: CompletionSuggestion[],
): CompletionSuggestion[] {
  if (!isProgramInputPromptText(promptText)) return suggestions;
  return suggestions.filter((suggestion) => suggestion.source === "snippet");
}

