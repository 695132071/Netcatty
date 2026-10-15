import type { IDisposable, ILink, Terminal } from '@xterm/xterm';
import { findTerminalArchives } from '../../../domain/terminalArchives';
import { pluginTerminalCellRange, readPluginTerminalBufferText } from '../pluginTerminalBufferText';

/** Archive commands are prepared only at an empty shell prompt, never submitted. */
export function registerTerminalArchiveLinks(options: {
  term: Terminal;
  isEnabled: () => boolean;
  isInputReady: () => boolean;
}): IDisposable {
  let disposed = false;
  const { term } = options;
  // Relative names belong only to output from the latest submitted command.
  // A marker follows scrollback trimming without keeping a cwd history.
  let commandStart = term.registerMarker(0);
  const submission = term.onData(data => {
    if (!/[\r\n]/u.test(data)) return;
    commandStart?.dispose();
    commandStart = term.registerMarker(0);
  });
  const hasRelativeContext = (y: number) => commandStart !== undefined
    && !commandStart.isDisposed && y - 1 > commandStart.line;
  const registration = term.registerLinkProvider({
    provideLinks(y, callback) {
      if (disposed || !options.isEnabled() || !options.isInputReady()) {
        callback(undefined);
        return;
      }
      const line = term.buffer.active.getLine(y - 1);
      // Do not mistake a fragment of a wrapped filename for a complete archive.
      if (!line || line.isWrapped || term.buffer.active.getLine(y)?.isWrapped) {
        callback(undefined);
        return;
      }
      const printed = readPluginTerminalBufferText(line, true);
      if (printed.text.length > 8192) {
        callback(undefined);
        return;
      }
      const links: ILink[] = findTerminalArchives(printed.text).flatMap((match) => {
        if (match.relative && !hasRelativeContext(y)) return [];
        const cells = pluginTerminalCellRange(printed, match.start, match.length);
        if (!cells) return [];
        return [{
          range: { start: { x: cells.x + 1, y }, end: { x: cells.x + cells.width, y } },
          text: match.text,
          decorations: { pointerCursor: true, underline: true },
          activate(event) {
            if (disposed || event.button !== 0 || !event.ctrlKey || !options.isEnabled() || !options.isInputReady()) return;
            if (match.relative && !hasRelativeContext(y)) return;
            if (term.buffer.active.getLine(y - 1)?.translateToString(true) !== printed.text) return;
            term.paste(match.command);
            term.focus();
          },
        }];
      });
      callback(links);
    },
  });
  return { dispose() { disposed = true; submission.dispose(); commandStart?.dispose(); registration.dispose(); } };
}
