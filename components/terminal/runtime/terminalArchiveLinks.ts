import type { IDisposable, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

import {
  buildArchiveExtractCommand,
  findTerminalArchiveTokens,
  resolveArchivePath,
} from "../../../domain/terminalArchives";
import type { LinkModifier } from "../../../domain/models/terminal";
import {
  readPluginTerminalBufferText,
  type PluginTerminalBufferText,
} from "../pluginTerminalBufferText";
import type { TerminalCwdInspection, TerminalCwdMarkers } from "./terminalCwdMarkers";

const MAX_LOGICAL_LINE_CHARS = 8192;

export interface TerminalArchiveLinkHost {
  term: Terminal;
  cwdMarkers: TerminalCwdMarkers;
  isConnected(): boolean;
  isBroadcasting(): boolean;
  isHostEligible(): boolean;
  isInputReady(): boolean;
  linkModifier(): LinkModifier;
}

interface LogicalSegment {
  lineNo: number;
  text: PluginTerminalBufferText;
  stringStart: number;
}

interface LogicalLine {
  text: string;
  segments: LogicalSegment[];
}

interface BufferCell {
  line: number;
  cell: number;
}

function readLogicalLine(term: Terminal, oneBasedY: number): LogicalLine | null {
  const buffer = term.buffer.active;
  const index = oneBasedY - 1;
  if (!buffer.getLine(index)) return null;
  let start = index;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;

  const segments: LogicalSegment[] = [];
  let total = 0;
  for (let lineNo = start; ; lineNo += 1) {
    const line = buffer.getLine(lineNo);
    if (!line) break;
    if (lineNo > start && !line.isWrapped) break;
    const next = buffer.getLine(lineNo + 1);
    const isLast = !next?.isWrapped;
    const text = readPluginTerminalBufferText(line, isLast);
    if (total + text.text.length > MAX_LOGICAL_LINE_CHARS) return null;
    segments.push({ lineNo, text, stringStart: total });
    total += text.text.length;
    if (isLast) break;
  }
  if (segments.length === 0) return null;
  return {
    text: segments.map((segment) => segment.text.text).join(""),
    segments,
  };
}

function cellAt(
  segments: readonly LogicalSegment[],
  offset: number,
  bound: "inclusive" | "exclusive",
): BufferCell | null {
  for (const segment of segments) {
    const local = offset - segment.stringStart;
    if (local < 0) return null;
    const length = segment.text.text.length;
    // A boundary offset is the next row's first cell for a token start, and the
    // previous row's exclusive end for a match that stops on that row.
    if (bound === "inclusive" ? local >= length : local > length) continue;
    const cell = segment.text.cellAtStringOffset[local];
    if (!Number.isInteger(cell)) return null;
    return { line: segment.lineNo, cell };
  }
  return null;
}

function sameSpan(left: TerminalCwdInspection, right: TerminalCwdInspection): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "ambiguous") return false;
  if (left.kind === "outside") return true;
  if (left.kind === "open") return right.kind === "open" && left.host === right.host;
  return right.kind === "closed" && left.key === right.key;
}

function modifierMatches(event: MouseEvent, modifier: LinkModifier): boolean {
  if (event.button !== 0) return false;
  if (modifier === "ctrl") return event.ctrlKey;
  if (modifier === "alt") return event.altKey;
  if (modifier === "meta") return event.metaKey;
  // "none" still requires Ctrl or Cmd. A configured modifier replaces that default.
  return event.ctrlKey || event.metaKey;
}

function neighborNeedsSpace(term: Terminal, direction: -1 | 1): boolean {
  const buffer = term.buffer.active;
  let lineIndex = buffer.baseY + buffer.cursorY;
  let line = buffer.getLine(lineIndex);
  if (!line || typeof line.getCell !== "function") return false;
  let index = buffer.cursorX + (direction < 0 ? -1 : 0);
  for (let steps = 0; steps < term.cols + 1; steps += 1) {
    if (index < 0 || index >= term.cols) {
      if (direction < 0) {
        if (!line.isWrapped) return false;
        lineIndex -= 1;
      } else {
        lineIndex += 1;
        const next = buffer.getLine(lineIndex);
        if (!next?.isWrapped) return false;
      }
      line = buffer.getLine(lineIndex);
      if (!line || typeof line.getCell !== "function") return false;
      index = direction < 0 ? term.cols - 1 : 0;
      continue;
    }
    const cell = line.getCell(index);
    if (!cell) return false;
    if (cell.getWidth() === 0) {
      index += direction;
      continue;
    }
    return (cell.getChars() || " ") !== " ";
  }
  return false;
}

/**
 * Ctrl/Cmd-click archive names to paste an absolute extract command.
 * Directory labels come only from OSC 7 markers; input is never observed.
 */
export function registerTerminalArchiveLinks(options: TerminalArchiveLinkHost): IDisposable {
  let disposed = false;
  const { term, cwdMarkers } = options;

  const sessionAllowsLinks = (): boolean => options.isConnected()
    && !options.isBroadcasting()
    && options.isHostEligible()
    && options.isInputReady()
    && term.buffer.active.type === "normal";

  const cwdFor = (path: string, start: BufferCell, end: BufferCell): string | null | undefined => {
    const left = cwdMarkers.inspectCell(start.line, start.cell);
    const right = cwdMarkers.inspectCell(end.line, end.cell);
    if (!sameSpan(left, right) || left.kind === "ambiguous") return undefined;
    const absolute = path.startsWith("/");
    if (absolute) {
      if (left.kind === "outside") return null;
      const latest = cwdMarkers.latestHost();
      if (latest != null && left.host !== latest) return undefined;
      return null;
    }
    if (left.kind !== "closed" || !left.trusted) return undefined;
    const latest = cwdMarkers.latestHost();
    if (latest != null && left.host !== latest) return undefined;
    return left.cwd;
  };

  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      if (disposed || !sessionAllowsLinks()) {
        callback(undefined);
        return;
      }
      const logical = readLogicalLine(term, bufferLineNumber);
      if (!logical || logical.text.length === 0) {
        callback(undefined);
        return;
      }
      const links: ILink[] = [];
      for (const token of findTerminalArchiveTokens(logical.text)) {
        const start = cellAt(logical.segments, token.start, "inclusive");
        const endExclusive = cellAt(logical.segments, token.start + token.length, "exclusive");
        const last = cellAt(logical.segments, token.start + token.length - 1, "inclusive");
        if (!start || !endExclusive || !last) continue;
        const cwd = cwdFor(token.path, start, last);
        if (cwd === undefined) continue;
        const abs = resolveArchivePath(token.path, cwd);
        const command = abs ? buildArchiveExtractCommand(abs) : null;
        if (!command) continue;
        const capturedText = logical.text;
        links.push({
          range: {
            start: { x: start.cell + 1, y: start.line + 1 },
            end: { x: endExclusive.cell, y: endExclusive.line + 1 },
          },
          text: token.text,
          decorations: { pointerCursor: true, underline: true },
          activate(event) {
            if (disposed || !modifierMatches(event, options.linkModifier())) return;
            if (!sessionAllowsLinks()) return;
            const fresh = readLogicalLine(term, start.line + 1);
            if (!fresh || fresh.text !== capturedText) return;
            const freshStart = cellAt(fresh.segments, token.start, "inclusive");
            const freshLast = cellAt(fresh.segments, token.start + token.length - 1, "inclusive");
            if (!freshStart || !freshLast) return;
            const freshCwd = cwdFor(token.path, freshStart, freshLast);
            if (freshCwd === undefined) return;
            const freshAbs = resolveArchivePath(token.path, freshCwd);
            const freshCommand = freshAbs ? buildArchiveExtractCommand(freshAbs) : null;
            if (!freshCommand || /[\r\n]/u.test(freshCommand)) return;
            const lead = neighborNeedsSpace(term, -1) ? " " : "";
            const trail = neighborNeedsSpace(term, 1) ? " " : "";
            term.paste(`${lead}${freshCommand}${trail}`);
            term.focus();
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };

  const registration = term.registerLinkProvider(provider);
  return {
    dispose() {
      disposed = true;
      registration.dispose();
    },
  };
}
