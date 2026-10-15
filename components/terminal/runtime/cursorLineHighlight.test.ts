import test from 'node:test';
import assert from 'node:assert/strict';

import { CursorLineHighlighter } from './cursorLineHighlight.ts';

type Handler = () => void;
type FakeElement = {
  style: Record<string, string>;
  attributes: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
};
const createFakeTerm = (cols = 80) => {
  let cursorY = 0;
  let cursorX = 0;
  let hasSelection = false;
  let baseY = 0;
  let bufferType: 'normal' | 'alternate' = 'normal';
  let lineLength = cols;
  const coloredBackgrounds = new Set<number>();
  const coloredForegrounds = new Set<number>();
  const inverseCells = new Set<number>();
  const cursorMoveHandlers: Handler[] = [];
  const writeParsedHandlers: Handler[] = [];
  const resizeHandlers: Handler[] = [];
  const bufferChangeHandlers: Handler[] = [];
  const renderHandlers: Handler[] = [];
  const selectionChangeHandlers: Handler[] = [];
  const decorations: Array<{
    options: Record<string, unknown>;
    disposed: boolean;
    element: FakeElement;
    dispose: () => void;
    onRender: (handler: (element: FakeElement) => void) => { dispose: () => void };
    onDispose: (handler: Handler) => { dispose: () => void };
  }> = [];
  const markers: Array<{ line: number; disposed: boolean; dispose: () => void }> = [];

  const term = {
    cols,
    buffer: {
      active: {
        get type() {
          return bufferType;
        },
        get baseY() {
          return baseY;
        },
        get cursorY() {
          return cursorY;
        },
        get cursorX() {
          return cursorX;
        },
        getLine() {
          return {
            length: cols,
            getCell(x: number) {
              return {
                getChars: () => (x < lineLength ? 'x' : ''),
                getWidth: () => 1,
                isAttributeDefault: () => x >= lineLength,
                isBgDefault: () => !coloredBackgrounds.has(x),
                isFgDefault: () => !coloredForegrounds.has(x),
                isInverse: () => (inverseCells.has(x) ? 1 : 0),
              };
            },
          };
        },
        getNullCell() {
          return { isBgDefault: () => true };
        },
      },
      onBufferChange(handler: Handler) {
        bufferChangeHandlers.push(handler);
        return { dispose() {} };
      },
    },
    onCursorMove(handler: Handler) {
      cursorMoveHandlers.push(handler);
      return { dispose() {} };
    },
    onResize(handler: Handler) {
      resizeHandlers.push(handler);
      return { dispose() {} };
    },
    onWriteParsed(handler: Handler) {
      writeParsedHandlers.push(handler);
      return { dispose() {} };
    },
    onRender(handler: Handler) {
      renderHandlers.push(handler);
      return { dispose() {} };
    },
    onSelectionChange(handler: Handler) {
      selectionChangeHandlers.push(handler);
      return { dispose() {} };
    },
    hasSelection() {
      return hasSelection;
    },
    registerMarker(offset: number) {
      const marker = {
        line: baseY + cursorY + offset,
        disposed: false,
        get isDisposed() {
          return this.disposed;
        },
        dispose() {
          this.disposed = true;
        },
      };
      markers.push(marker);
      return marker;
    },
    registerDecoration(options: Record<string, unknown>) {
      const disposeHandlers = new Set<Handler>();
      const element: FakeElement = {
        style: {},
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      };
      const decoration = {
        options,
        disposed: false,
        element,
        dispose() {
          if (this.disposed) return;
          this.disposed = true;
          for (const handler of disposeHandlers) handler();
          disposeHandlers.clear();
        },
        onDispose(handler: Handler) {
          disposeHandlers.add(handler);
          return { dispose: () => disposeHandlers.delete(handler) };
        },
        onRender(handler: (element: FakeElement) => void) {
          handler(element);
          return { dispose() {} };
        },
      };
      decorations.push(decoration);
      return decoration;
    },
    moveCursor(nextY: number) {
      cursorY = nextY;
      for (const handler of cursorMoveHandlers) handler();
      for (const handler of renderHandlers) handler();
    },
    scrollOutput(lines: number) {
      baseY += lines;
      for (const handler of writeParsedHandlers) handler();
      for (const handler of renderHandlers) handler();
    },
    writeHiddenOutput(lines: number) {
      baseY += lines;
      for (const handler of writeParsedHandlers) handler();
    },
    trimScrollback(lines: number) {
      for (const marker of markers) {
        if (!marker.disposed) marker.line -= lines;
      }
      for (const handler of writeParsedHandlers) handler();
      for (const handler of renderHandlers) handler();
    },
    setBufferType(nextType: 'normal' | 'alternate') {
      bufferType = nextType;
      for (const handler of bufferChangeHandlers) handler();
    },
    setColoredBackgrounds(columns: number[]) {
      coloredBackgrounds.clear();
      for (const column of columns) coloredBackgrounds.add(column);
      for (const handler of writeParsedHandlers) handler();
      for (const handler of renderHandlers) handler();
    },
    setLineLength(nextLength: number) {
      lineLength = nextLength;
      for (const handler of writeParsedHandlers) handler();
      for (const handler of renderHandlers) handler();
    },
    setCursorX(nextX: number) {
      cursorX = nextX;
      for (const handler of cursorMoveHandlers) handler();
      for (const handler of renderHandlers) handler();
    },
    setSelection(next: boolean) {
      hasSelection = next;
      for (const handler of selectionChangeHandlers) handler();
    },
    render() {
      for (const handler of renderHandlers) handler();
    },
    setColoredForegrounds(columns: number[]) {
      coloredForegrounds.clear();
      for (const column of columns) coloredForegrounds.add(column);
      for (const handler of writeParsedHandlers) handler();
      for (const handler of renderHandlers) handler();
    },
    setInverseCells(columns: number[]) {
      inverseCells.clear();
      for (const column of columns) inverseCells.add(column);
      for (const handler of writeParsedHandlers) handler();
      for (const handler of renderHandlers) handler();
    },
    resetDecorations() {
      for (const decoration of decorations) decoration.dispose();
    },
    setCols(nextCols: number) {
      term.cols = nextCols;
      for (const handler of resizeHandlers) handler();
    },
    decorations,
    markers,
  };

  return term;
};

test('CursorLineHighlighter paints an opaque background without changing text', () => {
  const term = createFakeTerm(100);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setBackgroundColor('#263449');
  highlighter.setEnabled(true);

  assert.equal(term.decorations.length, 1);
  assert.equal(term.decorations[0]?.options.width, 100);
  assert.equal(term.decorations[0]?.options.backgroundColor, '#263449');
  assert.equal(term.decorations[0]?.options.layer, 'bottom');
  highlighter.dispose();
});

test('CursorLineHighlighter gives selection and search matches priority', () => {
  const term = createFakeTerm(10);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setEnabled(true);
  assert.equal(term.decorations.at(-1)?.disposed, false);

  term.setSelection(true);
  assert.equal(term.decorations.at(-1)?.disposed, true);

  term.setSelection(false);
  assert.equal(term.decorations.at(-1)?.disposed, false);
  highlighter.dispose();
});

test('CursorLineHighlighter refreshes after hidden writes become visible', () => {
  const term = createFakeTerm(10);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setEnabled(true);
  assert.equal(term.markers.at(-1)?.line, 0);

  term.writeHiddenOutput(1);
  assert.equal(term.decorations.length, 1);
  term.render();

  assert.equal(term.decorations.length, 2);
  assert.equal(term.decorations[0]?.disposed, true);
  assert.equal(term.markers.at(-1)?.line, 1);
  highlighter.dispose();
});

test('CursorLineHighlighter keeps a continuous background under colored keyword text', () => {
  const term = createFakeTerm(10);
  const keywordMarker = term.registerMarker(0);
  term.registerDecoration({
    marker: keywordMarker,
    x: 2,
    width: 2,
    foregroundColor: '#F87171',
  });
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setBackgroundColor('#263449');
  highlighter.setEnabled(true);

  assert.equal(term.decorations[0]?.options.foregroundColor, '#F87171');
  assert.equal(term.decorations[0]?.options.backgroundColor, undefined);
  assert.equal(term.decorations[1]?.options.x, 0);
  assert.equal(term.decorations[1]?.options.width, 10);
  assert.equal(term.decorations[1]?.options.backgroundColor, '#263449');
  assert.equal(term.decorations[1]?.options.layer, 'bottom');
  highlighter.dispose();
});

test('CursorLineHighlighter leaves ANSI background cells untouched', () => {
  const term = createFakeTerm(10);
  term.setColoredBackgrounds([2, 3, 7]);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setBackgroundColor('#263449');
  highlighter.setEnabled(true);

  assert.deepEqual(
    term.decorations.map(({ options }) => ({ x: options.x, width: options.width })),
    [
      { x: 0, width: 2 },
      { x: 4, width: 3 },
      { x: 8, width: 2 },
    ],
  );
  highlighter.dispose();
});

test('CursorLineHighlighter fills the blank tail after short output', () => {
  const term = createFakeTerm(10);
  term.setLineLength(4);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setBackgroundColor('#263449');
  highlighter.setEnabled(true);

  assert.equal(term.decorations.length, 2);
  assert.equal(term.decorations[0]?.options.width, 4);
  assert.equal(term.decorations[1]?.options.x, 4);
  assert.equal(term.decorations[1]?.options.width, 6);
  assert.equal(term.decorations[1]?.options.backgroundColor, '#263449');
  assert.equal(term.decorations[1]?.options.layer, 'bottom');
  highlighter.dispose();
});

test('CursorLineHighlighter fills the blank tail through the cursor cell', () => {
  const term = createFakeTerm(10);
  term.setLineLength(4);
  term.setCursorX(5);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setBackgroundColor('#263449');
  highlighter.setEnabled(true);

  assert.deepEqual(
    term.decorations.map(({ options }) => ({ x: options.x, width: options.width })),
    [
      { x: 0, width: 4 },
      { x: 4, width: 6 },
    ],
  );
  highlighter.dispose();
});

test('CursorLineHighlighter fills a wrap-pending final cell', () => {
  const term = createFakeTerm(10);
  term.setLineLength(4);
  term.setCursorX(10);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setBackgroundColor('#263449');
  highlighter.setEnabled(true);

  assert.deepEqual(
    term.decorations.map(({ options }) => ({ x: options.x, width: options.width })),
    [
      { x: 0, width: 4 },
      { x: 4, width: 6 },
    ],
  );
  highlighter.dispose();
});

test('CursorLineHighlighter keeps foreground colors and leaves inverse cells untouched', () => {
  const term = createFakeTerm(10);
  term.setColoredForegrounds([2, 3]);
  term.setInverseCells([7]);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setBackgroundColor('#263449');
  highlighter.setEnabled(true);

  assert.deepEqual(
    term.decorations.map(({ options }) => ({ x: options.x, width: options.width })),
    [
      { x: 0, width: 7 },
      { x: 8, width: 2 },
    ],
  );
  highlighter.dispose();
});

test('CursorLineHighlighter follows cursor moves and clears when disabled', () => {
  const term = createFakeTerm(80);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setEnabled(true);
  assert.equal(term.decorations.length, 1);

  term.moveCursor(3);
  assert.equal(term.decorations.length, 2);
  assert.equal(term.decorations[0]?.disposed, true);
  assert.equal(term.decorations[1]?.disposed, false);

  highlighter.setEnabled(false);
  assert.equal(term.decorations[1]?.disposed, true);
  highlighter.dispose();
});

test('CursorLineHighlighter swaps decorations atomically on refresh', () => {
  const term = createFakeTerm(80);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setEnabled(true);
  const firstDecoration = term.decorations[0];
  assert.ok(firstDecoration);
  assert.equal(firstDecoration.disposed, false);

  let sawOverlap = false;
  const originalRegisterMarker = term.registerMarker.bind(term);
  term.registerMarker = (offset: number) => {
    // New marker must be created while the previous decoration is still live.
    if (!firstDecoration.disposed) sawOverlap = true;
    return originalRegisterMarker(offset);
  };

  term.moveCursor(2);

  assert.equal(sawOverlap, true, 'new marker should register before old decoration disposal');
  assert.equal(firstDecoration.disposed, true);
  assert.equal(term.decorations.at(-1)?.disposed, false);
  highlighter.dispose();
});

test('CursorLineHighlighter recreates on resize and overlay color changes', () => {
  const term = createFakeTerm(40);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setEnabled(true);
  highlighter.setBackgroundColor('#112233');
  assert.equal(
    term.decorations.at(-1)?.options.backgroundColor,
    '#112233',
  );
  assert.equal(term.decorations.at(-1)?.options.width, 40);

  term.setCols(120);
  assert.equal(term.decorations.at(-2)?.options.width, 40);
  assert.equal(term.decorations.at(-1)?.options.width, 80);

  highlighter.setBackgroundColor('#445566');
  assert.equal(
    term.decorations.at(-2)?.options.backgroundColor,
    '#445566',
  );
  highlighter.dispose();
});

test('CursorLineHighlighter follows bottom-row output when only baseY changes', () => {
  const term = createFakeTerm(80);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setEnabled(true);
  assert.equal(term.markers.at(-1)?.line, 0);

  term.scrollOutput(3);
  assert.equal(term.decorations.length, 2);
  assert.equal(term.decorations[0]?.disposed, true);
  assert.equal(term.markers.at(-1)?.line, 3);
  assert.equal(term.decorations.at(-1)?.disposed, false);
  highlighter.dispose();
});

test('CursorLineHighlighter refreshes when saturated scrollback moves its marker', () => {
  const term = createFakeTerm(80);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setEnabled(true);
  const originalMarker = term.markers.at(-1);
  assert.equal(originalMarker?.line, 0);

  term.trimScrollback(1);
  assert.equal(originalMarker?.disposed, true);
  assert.equal(term.decorations.length, 2);
  assert.equal(term.markers.at(-1)?.line, 0);
  assert.equal(term.decorations.at(-1)?.disposed, false);
  highlighter.dispose();
});

test('CursorLineHighlighter restores after the terminal resets its decorations', () => {
  const term = createFakeTerm(80);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setEnabled(true);
  assert.equal(term.decorations.length, 1);

  term.resetDecorations();
  assert.equal(term.decorations[0]?.disposed, true);

  term.scrollOutput(0);
  assert.equal(term.decorations.length, 2);
  assert.equal(term.decorations.at(-1)?.disposed, false);
  highlighter.dispose();
});

test('CursorLineHighlighter self-heals when xterm disposes its decorations without a write', () => {
  const term = createFakeTerm(80);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setEnabled(true);
  assert.equal(term.decorations.at(-1)?.disposed, false);

  // xterm-side disposal (decoration service reset / term.reset): no cursor
  // move and no write follow, only the next render frame.
  term.resetDecorations();
  assert.equal(term.decorations[0]?.disposed, true);

  term.render();
  assert.equal(term.decorations.at(-1)?.disposed, false);
  assert.equal(term.decorations.at(-1)?.options.width, 80);
  highlighter.dispose();
});

test('CursorLineHighlighter recreates after a buffer clear wipes markers and decorations', () => {
  const term = createFakeTerm(80);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setEnabled(true);
  assert.equal(term.markers.at(-1)?.disposed, false);

  // term.clear() disposes every marker; decorations follow their markers.
  for (const marker of term.markers) marker.dispose();
  term.resetDecorations();
  assert.equal(term.decorations.at(-1)?.disposed, true);

  term.render();
  assert.equal(term.decorations.at(-1)?.disposed, false);
  assert.equal(term.markers.at(-1)?.line, 0);
  highlighter.dispose();
});

test('CursorLineHighlighter does not duplicate decorations on redundant renders', () => {
  const term = createFakeTerm(80);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setEnabled(true);
  const aliveBefore = term.decorations.filter((decoration) => !decoration.disposed).length;

  term.render();
  term.render();
  assert.equal(
    term.decorations.filter((decoration) => !decoration.disposed).length,
    aliveBefore,
  );
  highlighter.dispose();
});

test('CursorLineHighlighter does not churn markers when a fully colored row has no decorations', () => {
  const cols = 8;
  const term = createFakeTerm(cols);
  // Every cell has an explicit ANSI background and the row is full, so both
  // highlight ranges and the blank tail are legitimately empty.
  term.setColoredBackgrounds(Array.from({ length: cols }, (_, column) => column));
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setEnabled(true);

  assert.equal(term.decorations.length, 0);
  assert.equal(term.markers.length, 1);
  const marker = term.markers[0];
  assert.ok(marker);
  assert.equal(marker.disposed, false);
  assert.equal(marker.line, 0);
  const aliveBefore = term.markers.filter((candidate) => !candidate.disposed).length;

  term.render();
  term.render();
  term.render();

  assert.equal(term.markers.length, 1);
  assert.equal(term.markers.filter((candidate) => !candidate.disposed).length, aliveBefore);
  assert.equal(marker.disposed, false);
  assert.equal(marker.line, 0);
  assert.equal(term.decorations.length, 0);
  highlighter.dispose();
});

test('CursorLineHighlighter clears in the alternate buffer and restores in normal buffer', () => {
  const term = createFakeTerm(80);
  const highlighter = new CursorLineHighlighter(term as never);
  highlighter.setEnabled(true);
  assert.equal(term.decorations.at(-1)?.disposed, false);

  term.setBufferType('alternate');
  assert.equal(term.decorations.at(-1)?.disposed, true);

  const decorationCount = term.decorations.length;
  term.moveCursor(4);
  term.scrollOutput(1);
  assert.equal(term.decorations.length, decorationCount);

  term.setBufferType('normal');
  assert.equal(term.decorations.length, decorationCount + 1);
  assert.equal(term.decorations.at(-1)?.disposed, false);
  highlighter.dispose();
});
