const MAX_CWD_MARKERS = 5000;

interface CwdMarker {
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
}

export interface TerminalCwdMarkerTerminal {
  readonly cols: number;
  readonly buffer: {
    readonly active: {
      readonly type: "normal" | "alternate";
      readonly cursorX: number;
    };
  };
  registerMarker(cursorYOffset: number): CwdMarker | undefined;
}

interface CwdMarkerEntry {
  id: number;
  marker: CwdMarker;
  x: number;
  cols: number;
  cwd: string;
  host: string;
}

export interface TerminalCwdCell {
  cwd: string;
  host: string;
}

export type TerminalCwdInspection =
  | { kind: "outside" }
  | { kind: "ambiguous" }
  | { kind: "open"; host: string; cwd: string }
  | { kind: "closed"; host: string; cwd: string; trusted: boolean; key: string };

export interface TerminalCwdMarkers {
  note(report: { cwd: string; host: string }): void;
  resolveCell(row: number, col: number): TerminalCwdCell | null;
  inspectCell(row: number, col: number): TerminalCwdInspection;
  latestHost(): string | null;
  dispose(): void;
}

/**
 * OSC 7 cwd labels. Output is trusted only between two markers that agree.
 * Nothing here watches keyboard or paste input.
 */
export function createTerminalCwdMarkers(term: TerminalCwdMarkerTerminal): TerminalCwdMarkers {
  let entries: CwdMarkerEntry[] = [];
  let nextId = 1;
  let disposed = false;

  const liveEntries = (): CwdMarkerEntry[] => {
    if (entries.some((entry) => entry.marker.isDisposed)) {
      entries = entries.filter((entry) => !entry.marker.isDisposed);
    }
    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index - 1].marker.line > entries[index].marker.line) {
        entries.sort((left, right) => left.marker.line - right.marker.line);
        break;
      }
    }
    return entries;
  };

  const relation = (
    row: number,
    col: number,
    entry: CwdMarkerEntry,
  ): "before" | "atOrAfter" | "ambiguous" => {
    const line = entry.marker.line;
    if (row < line) return "before";
    if (row > line) return "atOrAfter";
    if (term.cols !== entry.cols) return "ambiguous";
    return col < entry.x ? "before" : "atOrAfter";
  };

  const inspectCell = (row: number, col: number): TerminalCwdInspection => {
    const list = liveEntries();
    if (list.length === 0) return { kind: "outside" };
    let start: CwdMarkerEntry | null = null;
    for (const entry of list) {
      const where = relation(row, col, entry);
      if (where === "ambiguous") return { kind: "ambiguous" };
      if (where === "before") {
        if (!start) return { kind: "outside" };
        if (start.host !== entry.host) return { kind: "ambiguous" };
        return {
          kind: "closed",
          host: start.host,
          cwd: start.cwd,
          trusted: start.cwd === entry.cwd,
          key: `${start.id}:${entry.id}`,
        };
      }
      start = entry;
    }
    if (!start) return { kind: "outside" };
    return { kind: "open", host: start.host, cwd: start.cwd };
  };

  return {
    note(report) {
      if (disposed || term.buffer.active.type !== "normal") return;
      const marker = term.registerMarker(0);
      if (!marker) return;
      const fresh: CwdMarkerEntry = {
        id: nextId,
        marker,
        x: term.buffer.active.cursorX,
        cols: term.cols,
        cwd: report.cwd,
        host: report.host,
      };
      nextId += 1;
      const kept: CwdMarkerEntry[] = [];
      for (const entry of entries) {
        if (entry.marker.isDisposed || entry.marker.line >= marker.line) {
          if (!entry.marker.isDisposed) entry.marker.dispose();
          continue;
        }
        kept.push(entry);
      }
      kept.push(fresh);
      while (kept.length > MAX_CWD_MARKERS) {
        const removed = kept.shift();
        if (removed && !removed.marker.isDisposed) removed.marker.dispose();
      }
      entries = kept;
    },
    inspectCell,
    resolveCell(row, col) {
      const inspection = inspectCell(row, col);
      if (inspection.kind !== "closed" || !inspection.trusted) return null;
      return { cwd: inspection.cwd, host: inspection.host };
    },
    latestHost() {
      const list = liveEntries();
      return list.length > 0 ? list[list.length - 1].host : null;
    },
    dispose() {
      disposed = true;
      for (const entry of entries) {
        if (!entry.marker.isDisposed) entry.marker.dispose();
      }
      entries = [];
    },
  };
}
