import type {
  IDecoration,
  IDisposable,
  IMarker,
  Terminal as XTerm,
} from '@xterm/xterm';

type CursorLineTerminal = Pick<
  XTerm,
  | 'cols'
  | 'buffer'
  | 'registerMarker'
  | 'registerDecoration'
  | 'onCursorMove'
  | 'onResize'
  | 'onWriteParsed'
  | 'onRender'
  | 'onSelectionChange'
  | 'hasSelection'
>;

type HighlightRange = { x: number; width: number };

/**
 * Highlights the buffer row under the cursor without tinting its glyphs.
 * Explicit ANSI backgrounds remain untouched. Foreground-only colors still
 * receive the opaque theme background so colored text does not leave holes.
 */
export class CursorLineHighlighter implements IDisposable {
  private enabled = false;
  private backgroundColor = '#263449';
  private marker: IMarker | null = null;
  private decorations: IDecoration[] = [];
  private decorationDisposeListeners: IDisposable[] = [];
  private activeLine: number | null = null;
  private activeCols: number | null = null;
  private activeColor: string | null = null;
  private activeRanges: HighlightRange[] = [];
  private activeTailRanges: HighlightRange[] = [];
  /** False once any tracked decoration has been disposed out from under us. */
  private decorationsAlive = false;
  private readonly disposables: IDisposable[] = [];
  private pendingRefresh = false;
  private disposed = false;

  constructor(private readonly term: CursorLineTerminal) {
    this.disposables.push(
      this.term.onCursorMove(() => this.markPendingRefresh()),
      this.term.onWriteParsed(() => this.markPendingRefresh()),
      this.term.onRender(() => {
        const pending = this.pendingRefresh;
        this.pendingRefresh = false;
        if (this.disposed || !this.enabled) return;
        // Writes and cursor moves defer to render, but xterm can also dispose
        // or clear our decorations out from under us (term.clear/reset,
        // decoration service resets, marker reindexing) without any further
        // cursor move or write. Verify the tracked set on every render so the
        // highlight can self-heal at the cursor line instead of staying
        // anchored to stale bookkeeping (wrong/missing line).
        if (pending || !this.isTrackingIntact()) this.refresh();
      }),
      this.term.onSelectionChange(() => this.refresh({ force: true })),
      this.term.onResize(() => this.refresh({ force: true })),
      this.term.buffer.onBufferChange(() => this.refresh({ force: true })),
    );
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    if (this.enabled === enabled) {
      if (enabled) this.refresh();
      return;
    }
    this.enabled = enabled;
    if (!enabled) {
      this.clear();
      return;
    }
    this.refresh({ force: true });
  }

  setBackgroundColor(color: string): void {
    if (this.disposed) return;
    const next = color.trim();
    if (!next || next === this.backgroundColor) return;
    this.backgroundColor = next;
    if (this.enabled) this.refresh({ force: true });
  }

  refresh(options: { force?: boolean } = {}): void {
    if (this.disposed || !this.enabled) return;
    this.pendingRefresh = false;

    if (this.term.hasSelection()) {
      this.clear();
      return;
    }

    const buffer = this.term.buffer.active;
    if (buffer.type === 'alternate') {
      this.clear();
      return;
    }
    const absoluteLine = buffer.baseY + buffer.cursorY;
    const cols = Math.max(1, this.term.cols || 1);
    const color = this.backgroundColor;
    const line = buffer.getLine(absoluteLine);
    const { ranges, contentEnd } = this.getDefaultBackgroundRanges(
      line,
      cols,
      buffer.getNullCell(),
    );
    const tailRanges = this.getTailRanges(contentEnd, cols);

    if (
      !options.force &&
      absoluteLine === this.activeLine &&
      cols === this.activeCols &&
      color === this.activeColor &&
      rangesEqual(ranges, this.activeRanges) &&
      rangesEqual(tailRanges, this.activeTailRanges) &&
      this.decorationsAlive &&
      this.marker &&
      !this.marker.isDisposed &&
      this.marker.line === absoluteLine
    ) {
      return;
    }

    // Register the next marker/decorations before disposing the previous set so
    // Enter / cursor moves never leave an empty frame (clear-then-create flash).
    const previousMarker = this.marker;
    const previousDecorations = this.decorations;
    const previousDisposeListeners = this.decorationDisposeListeners;

    const marker = this.term.registerMarker(0);
    if (!marker) {
      this.clearOwned(
        previousMarker,
        previousDecorations,
        previousDisposeListeners,
      );
      return;
    }

    const decorations: IDecoration[] = [];
    for (const range of ranges) {
      const decoration = this.term.registerDecoration({
        marker,
        x: range.x,
        width: range.width,
        backgroundColor: color,
        layer: 'bottom',
      });
      if (decoration) decorations.push(decoration);
    }
    for (const tailRange of tailRanges) {
      const tailDecoration = this.term.registerDecoration({
        marker,
        x: tailRange.x,
        width: tailRange.width,
        backgroundColor: color,
        layer: 'bottom',
      });
      if (tailDecoration) {
        decorations.push(tailDecoration);
      }
    }

    this.marker = marker;
    this.decorations = decorations;
    // An empty set is valid when the whole row already has ANSI backgrounds or
    // inverse cells. Tracking stays intact so later frames do not churn markers.
    this.decorationsAlive = true;
    this.decorationDisposeListeners = decorations.map((decoration) =>
      decoration.onDispose(() => {
        if (this.decorations.includes(decoration)) {
          this.decorationsAlive = false;
          this.activeLine = null;
          this.activeCols = null;
          this.activeColor = null;
          this.activeRanges = [];
          this.activeTailRanges = [];
        }
      }),
    );
    this.activeLine = absoluteLine;
    this.activeCols = cols;
    this.activeColor = color;
    this.activeRanges = ranges;
    this.activeTailRanges = tailRanges;

    this.clearOwned(
      previousMarker,
      previousDecorations,
      previousDisposeListeners,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private getDefaultBackgroundRanges(
    line: ReturnType<CursorLineTerminal['buffer']['active']['getLine']>,
    cols: number,
    cell: ReturnType<CursorLineTerminal['buffer']['active']['getNullCell']>,
  ): { ranges: HighlightRange[]; contentEnd: number } {
    const ranges: HighlightRange[] = [];
    let rangeStart: number | null = null;
    let contentEnd = 0;
    for (let x = 0; x < cols; x += 1) {
      const currentCell = line?.getCell(x, cell);
      if (
        currentCell &&
        (currentCell.getChars() !== '' || !currentCell.isAttributeDefault())
      ) {
        contentEnd = Math.min(cols, x + Math.max(1, currentCell.getWidth()));
      }
      const isHighlightable =
        currentCell === undefined ||
        (currentCell.isBgDefault() && !currentCell.isInverse());
      if (isHighlightable && rangeStart === null) rangeStart = x;
      if ((!isHighlightable || x === cols - 1) && rangeStart !== null) {
        const end = isHighlightable && x === cols - 1 ? x + 1 : x;
        ranges.push({ x: rangeStart, width: end - rangeStart });
        rangeStart = null;
      }
    }
    return {
      ranges: ranges
        .map((range) => {
          const end = Math.min(range.x + range.width, contentEnd);
          return { x: range.x, width: end - range.x };
        })
        .filter((range) => range.width > 0),
      contentEnd,
    };
  }

  private getTailRanges(contentEnd: number, cols: number): HighlightRange[] {
    if (contentEnd >= cols) return [];
    return [{ x: contentEnd, width: cols - contentEnd }];
  }

  private clear(): void {
    this.clearOwned(
      this.marker,
      this.decorations,
      this.decorationDisposeListeners,
    );
    this.marker = null;
    this.decorations = [];
    this.decorationDisposeListeners = [];
    this.decorationsAlive = false;
    this.activeLine = null;
    this.activeCols = null;
    this.activeColor = null;
    this.activeRanges = [];
    this.activeTailRanges = [];
  }

  /**
   * Cheap render-time check that the tracked marker and decorations are still
   * owned by xterm. xterm disposes highlight decorations on buffer clears,
   * resets, and marker reindexing without emitting cursor-move/write events,
   * so a stale tracking state must be recreated before the next frame paints.
   */
  private isTrackingIntact(): boolean {
    if (this.marker === null || this.marker.isDisposed) {
      return this.marker === null && this.decorations.length === 0;
    }
    return this.decorationsAlive;
  }

  private clearOwned(
    marker: IMarker | null,
    decorations: IDecoration[],
    disposeListeners: IDisposable[],
  ): void {
    for (const disposable of disposeListeners) disposable.dispose();
    for (const decoration of decorations) decoration.dispose();
    marker?.dispose();
  }

  private markPendingRefresh(): void {
    if (!this.disposed && this.enabled) this.pendingRefresh = true;
  }
}

const rangesEqual = (left: HighlightRange[], right: HighlightRange[]): boolean =>
  left.length === right.length && left.every((range, index) => {
    const other = right[index];
    return other?.x === range.x && other.width === range.width;
  });
