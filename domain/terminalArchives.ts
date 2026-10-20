import { resolveHostOs } from "./host";
import type { Host } from "./models";

const REMOTE_SHELL_PROTOCOLS = new Set(["ssh", "mosh", "et"]);

/**
 * Linux shells only. Windows, including WSL local shells (a win32 app hosting
 * a Linux guest), macOS, telnet, serial, plugin protocols, and network devices
 * are excluded.
 */
export function supportsTerminalArchiveCommands(host: Host, localPlatform: string): boolean {
  if (host.protocol === "local") return localPlatform === "linux";
  if (host.protocol && !REMOTE_SHELL_PROTOCOLS.has(host.protocol)) return false;
  if (host.deviceType === "network") return false;
  return resolveHostOs(host) === "linux";
}

const ARCHIVE_SUFFIXES = [
  ".tar.gz",
  ".tar.bz2",
  ".tar.xz",
  ".tbz2",
  ".tgz",
  ".tar",
  ".zip",
] as const;

const OPEN_TO_CLOSE: Record<string, string> = {
  "'": "'",
  '"': '"',
  "\u201c": "\u201d",
  "\u2018": "\u2019",
};

export interface TerminalArchiveToken {
  start: number;
  length: number;
  text: string;
  path: string;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function archiveSuffix(name: string): string | null {
  const lower = name.toLowerCase();
  for (const suffix of ARCHIVE_SUFFIXES) {
    if (lower.endsWith(suffix) && name.length > suffix.length) return suffix;
  }
  return null;
}

function rejectedArchivePath(path: string, suffix: string): boolean {
  if (!path || hasControlChar(path)) return true;
  if (path.startsWith("~")) return true;
  const slash = path.indexOf("/");
  const head = slash === -1 ? path : path.slice(0, slash);
  if (head.includes(":")) return true;
  if (path.includes("\\")) return true;
  if (path.includes("!")) return true;
  if (suffix === ".zip" && /[*?[]/u.test(path)) return true;
  return false;
}

/** Whitespace-delimited archive names, including one matched quote pair or escaped spaces. */
export function findTerminalArchiveTokens(line: string): TerminalArchiveToken[] {
  const tokens: TerminalArchiveToken[] = [];
  let index = 0;
  while (index < line.length) {
    const char = line[index] ?? "";
    if (isWhitespace(char)) {
      index += 1;
      continue;
    }
    const closer = OPEN_TO_CLOSE[char];
    if (closer) {
      const end = line.indexOf(closer, index + 1);
      if (end < 0) {
        while (index < line.length && !isWhitespace(line[index] ?? "")) index += 1;
        continue;
      }
      const path = line.slice(index + 1, end);
      const text = line.slice(index, end + 1);
      const suffix = archiveSuffix(path);
      if (suffix && !rejectedArchivePath(path, suffix)) {
        tokens.push({ start: index, length: text.length, text, path });
      }
      index = end + 1;
      continue;
    }

    let cursor = index;
    let path = "";
    while (cursor < line.length && !isWhitespace(line[cursor] ?? "")) {
      if (line[cursor] === "\\" && line[cursor + 1] === " ") {
        path += " ";
        cursor += 2;
        continue;
      }
      path += line[cursor] ?? "";
      cursor += 1;
    }
    const text = line.slice(index, cursor);
    const suffix = archiveSuffix(path);
    if (suffix && !rejectedArchivePath(path, suffix)) {
      tokens.push({ start: index, length: text.length, text, path });
    }
    index = cursor;
  }
  return tokens;
}

function posixNormalize(input: string): string {
  const absolute = input.startsWith("/");
  const parts: string[] = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (absolute) return parts.length > 0 ? `/${parts.join("/")}` : "/";
  return parts.length > 0 ? parts.join("/") : ".";
}

function posixDirname(absPath: string): string {
  const normalized = posixNormalize(absPath);
  if (!normalized.startsWith("/") || normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

/** Resolve a printed name against an OSC 7 cwd. Relative names without a cwd are unknown. */
export function resolveArchivePath(filePath: string, cwd: string | null): string | null {
  if (!filePath) return null;
  if (filePath.startsWith("/")) return posixNormalize(filePath);
  if (!cwd || !cwd.startsWith("/")) return null;
  const normalized = posixNormalize(`${cwd}/${filePath}`);
  return normalized.startsWith("/") ? normalized : null;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Fill-only extract command. The archive is unpacked next to itself. */
export function buildArchiveExtractCommand(absPath: string): string | null {
  const suffix = archiveSuffix(absPath);
  if (!suffix) return null;
  const quotedPath = shellQuote(posixNormalize(absPath));
  const quotedDir = shellQuote(posixDirname(absPath));
  switch (suffix) {
    case ".tar":
      return `tar -xvf ${quotedPath} -C ${quotedDir}`;
    case ".tar.gz":
    case ".tgz":
      return `tar -xvzf ${quotedPath} -C ${quotedDir}`;
    case ".tar.bz2":
    case ".tbz2":
      return `tar -xvjf ${quotedPath} -C ${quotedDir}`;
    case ".tar.xz":
      return `tar -xvJf ${quotedPath} -C ${quotedDir}`;
    case ".zip":
      return `unzip ${quotedPath} -d ${quotedDir}`;
    default:
      return null;
  }
}
