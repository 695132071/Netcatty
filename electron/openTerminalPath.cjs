const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const OPEN_TERMINAL_PATH_CHANNEL = "netcatty:openTerminalPath";
const OPEN_TERMINAL_PATH_ARG = "--open-terminal-path";
const OPEN_TERMINAL_SHELL_ARG = "--open-terminal-shell";
// Discovered ids are short. The cap still leaves room for a nested executable
// path. Main only sanity-checks; the renderer resolves the id or path.
const MAX_OPEN_TERMINAL_SHELL_LENGTH = 4096;

function expandHomePath(targetPath, { osHomedir = os.homedir } = {}) {
  if (!targetPath) return targetPath;
  if (targetPath === "~") return osHomedir();
  if (targetPath.startsWith("~/")) return path.join(osHomedir(), targetPath.slice(2));
  return targetPath;
}

/**
 * Normalize raw CLI / shell path tokens before resolution.
 * Handles leftover quotes, trailing dots from the Windows shell `"%1."` trick,
 * and drive-root trailing separators.
 */
function normalizeOpenTerminalPathToken(rawPath) {
  if (typeof rawPath !== "string") return "";
  let value = rawPath.trim();
  if (!value) return "";

  // Strip one layer of matching quotes that may survive argv parsing.
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1).trim();
  }

  // Windows shell verbs use `"%1."` / `"%V."` so drive roots don't break quoting.
  // Drop a single trailing dot when it is not part of a `..` segment.
  if (process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) {
    if (value.length > 1 && value.endsWith(".") && !value.endsWith("..")) {
      value = value.slice(0, -1);
    }
    // Normalize trailing separators except for drive roots like `C:\`.
    if (/^[A-Za-z]:\\$/.test(value) || /^[A-Za-z]:\/$/.test(value)) {
      return value;
    }
    while (value.length > 1 && (value.endsWith("\\") || value.endsWith("/"))) {
      value = value.slice(0, -1);
    }
  }

  return value;
}

function isOpenTerminalFlag(arg) {
  return arg === OPEN_TERMINAL_PATH_ARG
    || arg === OPEN_TERMINAL_SHELL_ARG
    || (typeof arg === "string" && (
      arg.startsWith(`${OPEN_TERMINAL_PATH_ARG}=`)
      || arg.startsWith(`${OPEN_TERMINAL_SHELL_ARG}=`)
    ));
}

function readOpenTerminalFlagValue(argv, index, flag) {
  const arg = argv[index];
  if (arg === flag) {
    const next = argv[index + 1];
    if (typeof next !== "string" || !next.trim() || isOpenTerminalFlag(next)) {
      return { value: "", consumed: 0 };
    }
    return { value: next, consumed: 1 };
  }
  const prefix = `${flag}=`;
  if (typeof arg === "string" && arg.startsWith(prefix)) {
    return { value: arg.slice(prefix.length), consumed: 0 };
  }
  return null;
}

function sanitizeOpenTerminalShell(rawShell) {
  if (typeof rawShell !== "string") return "";
  let value = rawShell.trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1).trim();
  }
  if (!value) return "";
  if (value.length > MAX_OPEN_TERMINAL_SHELL_LENGTH) return "";
  if (value.includes("\0")) return "";
  return value;
}

/**
 * Group adjacent path and shell flags into launch requests.
 * A second path or shell starts a new request. Either field may be absent.
 */
function collectOpenTerminalRequests(argv) {
  if (!Array.isArray(argv)) return [];
  const requests = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    if (current.path || current.shell) requests.push(current);
    current = null;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== "string") continue;

    const pathFlag = readOpenTerminalFlagValue(argv, index, OPEN_TERMINAL_PATH_ARG);
    if (pathFlag) {
      if (current?.path) flush();
      const normalized = normalizeOpenTerminalPathToken(pathFlag.value);
      if (normalized) {
        if (!current) current = {};
        current.path = normalized;
      }
      index += pathFlag.consumed;
      continue;
    }

    const shellFlag = readOpenTerminalFlagValue(argv, index, OPEN_TERMINAL_SHELL_ARG);
    if (shellFlag) {
      if (current?.shell) flush();
      const shell = sanitizeOpenTerminalShell(shellFlag.value);
      if (shell) {
        if (!current) current = {};
        current.shell = shell;
      }
      index += shellFlag.consumed;
      continue;
    }
  }

  flush();
  return requests;
}

function collectOpenTerminalPathArgs(argv) {
  return collectOpenTerminalRequests(argv)
    .map((request) => request.path)
    .filter(Boolean);
}

function hasOpenTerminalLaunchArgs(argv) {
  if (!Array.isArray(argv)) return false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== "string") continue;
    if (arg === OPEN_TERMINAL_PATH_ARG || arg === OPEN_TERMINAL_SHELL_ARG) {
      const next = argv[index + 1];
      if (typeof next === "string" && next.trim() && !isOpenTerminalFlag(next)) return true;
      continue;
    }
    const pathPrefix = `${OPEN_TERMINAL_PATH_ARG}=`;
    const shellPrefix = `${OPEN_TERMINAL_SHELL_ARG}=`;
    if (arg.startsWith(pathPrefix) || arg.startsWith(shellPrefix)) {
      const value = arg.startsWith(pathPrefix)
        ? arg.slice(pathPrefix.length)
        : arg.slice(shellPrefix.length);
      if (value.trim()) return true;
    }
  }
  return false;
}

function resolveOpenTerminalPath(rawPath, {
  baseDirectory,
  fsModule = fs,
  pathModule = path,
  logWarn = console.warn,
} = {}) {
  const normalized = normalizeOpenTerminalPathToken(rawPath);
  if (!normalized) return null;

  try {
    const expanded = expandHomePath(normalized);
    const resolved = pathModule.isAbsolute(expanded)
      ? pathModule.resolve(expanded)
      : pathModule.resolve(baseDirectory || process.cwd(), expanded);
    const stat = fsModule.statSync(resolved);
    if (stat.isDirectory()) return resolved;
    if (stat.isFile()) return pathModule.dirname(resolved);
    return null;
  } catch (err) {
    logWarn?.("[Main] Ignoring invalid terminal open path:", rawPath, err?.message || err);
    return null;
  }
}

function resolveOpenTerminalRequestsFromArgs(argv, options = {}) {
  const requests = [];
  for (const raw of collectOpenTerminalRequests(argv)) {
    if (raw.path) {
      const resolvedPath = resolveOpenTerminalPath(raw.path, options);
      // A requested directory that does not resolve must not fall open in the
      // default directory, even when a shell was paired with it.
      if (!resolvedPath) continue;
      requests.push(raw.shell ? { path: resolvedPath, shell: raw.shell } : { path: resolvedPath });
      continue;
    }
    if (raw.shell) requests.push({ shell: raw.shell });
  }
  return requests;
}

function resolveOpenTerminalPathsFromArgs(argv, options = {}) {
  return resolveOpenTerminalRequestsFromArgs(argv, options)
    .map((request) => request.path)
    .filter(Boolean);
}

module.exports = {
  MAX_OPEN_TERMINAL_SHELL_LENGTH,
  OPEN_TERMINAL_PATH_ARG,
  OPEN_TERMINAL_PATH_CHANNEL,
  OPEN_TERMINAL_SHELL_ARG,
  collectOpenTerminalPathArgs,
  collectOpenTerminalRequests,
  expandHomePath,
  hasOpenTerminalLaunchArgs,
  normalizeOpenTerminalPathToken,
  resolveOpenTerminalPath,
  resolveOpenTerminalPathsFromArgs,
  resolveOpenTerminalRequestsFromArgs,
  sanitizeOpenTerminalShell,
};
