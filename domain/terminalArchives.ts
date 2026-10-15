import { resolveHostOs } from './host';
import type { Host } from './models';

export function supportsTerminalArchiveCommands(host: Host, localPlatform: string): boolean {
  if (host.protocol === 'local') return localPlatform === 'linux';
  if (host.protocol && !['ssh', 'mosh', 'et'].includes(host.protocol)) return false;
  return host.deviceType !== 'network' && resolveHostOs(host) === 'linux';
}

const TAR_OPTIONS: Record<string, string> = {
  '.tar': '-xf',
  '.tar.gz': '-xzf',
  '.tgz': '-xzf',
  '.tar.bz2': '-xjf',
  '.tbz2': '-xjf',
  '.tar.xz': '-xJf',
  '.txz': '-xJf',
};

function archiveCommand(file: string): string | null {
  if (Array.from(file).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || /^[a-z][a-z0-9+.-]*:/iu.test(file)) return null;
  const suffix = Object.keys(TAR_OPTIONS).find((extension) => file.endsWith(extension));
  if (!suffix && !file.endsWith('.zip')) return null;
  // Prefix relative paths so an archive named "-options.zip" is never an option.
  const path = file.startsWith('/') || file.startsWith('~/') ? file : `./${file}`;
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const argument = path.startsWith('~/') ? `"$HOME"/${quote(path.slice(2))}` : quote(path);
  return suffix ? `tar ${TAR_OPTIONS[suffix]} ${argument}` : `unzip ${argument}`;
}

export interface TerminalArchiveMatch {
  start: number;
  length: number;
  text: string;
  command: string;
  relative: boolean;
}

/** One printed token, or an explicitly quoted filename containing spaces. */
export function findTerminalArchives(line: string): TerminalArchiveMatch[] {
  const tokens = /(^|\s)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))(?=\s|$)/gu;
  return Array.from(line.matchAll(tokens)).flatMap((match) => {
    const text = match[0].slice(match[1].length);
    const file = match[2] ?? match[3] ?? match[4];
    const command = archiveCommand(file);
    return command ? [{ start: match.index + match[1].length, length: text.length, text, command,
      relative: !file.startsWith('/') && !file.startsWith('~/'),
    }] : [];
  });
}
